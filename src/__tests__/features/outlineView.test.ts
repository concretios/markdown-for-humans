import * as vscode from 'vscode';
import { OutlineViewProvider, OutlineEntry } from '../../features/outlineView';

describe('OutlineViewProvider', () => {
  // Sample outline: H1 > H2 > H3, H1 > H2b
  const sampleOutline: OutlineEntry[] = [
    { level: 1, text: 'H1', pos: 0, sectionEnd: 100 },
    { level: 2, text: 'H2', pos: 10, sectionEnd: 50 },
    { level: 3, text: 'H3', pos: 20, sectionEnd: 30 },
    { level: 2, text: 'H2b', pos: 60, sectionEnd: 90 },
  ];

  describe('basic tree operations', () => {
    it('returns empty when no outline set', async () => {
      const provider = new OutlineViewProvider();
      const children = await provider.getChildren();
      expect(children).toEqual([]);
    });

    it('builds a tree structure with nested children', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline(sampleOutline);

      const roots = await provider.getChildren();
      expect(roots?.length).toBe(1);
      const h1 = roots?.[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h1Children = await provider.getChildren(h1 as any);
      expect(h1Children?.length).toBe(2);
      const h2 = h1Children?.[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h2Children = await provider.getChildren(h2 as any);
      expect(h2Children?.length).toBe(1);
    });

    it('handles empty heading text gracefully', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline([{ level: 1, text: '', pos: 0, sectionEnd: 10 }]);

      const roots = await provider.getChildren();
      // When not active/ancestor, label is plain string
      expect(roots?.[0]?.label).toBe('(Untitled)');
    });

    it('handles multiple root-level headings', async () => {
      const multiRoot: OutlineEntry[] = [
        { level: 1, text: 'First H1', pos: 0, sectionEnd: 50 },
        { level: 1, text: 'Second H1', pos: 50, sectionEnd: 100 },
        { level: 1, text: 'Third H1', pos: 100, sectionEnd: 150 },
      ];
      const provider = new OutlineViewProvider();
      provider.setOutline(multiRoot);

      const roots = await provider.getChildren();
      expect(roots?.length).toBe(3);
    });

    it('handles deeply nested headings (H1-H6)', async () => {
      const deepNesting: OutlineEntry[] = [
        { level: 1, text: 'H1', pos: 0, sectionEnd: 100 },
        { level: 2, text: 'H2', pos: 10, sectionEnd: 90 },
        { level: 3, text: 'H3', pos: 20, sectionEnd: 80 },
        { level: 4, text: 'H4', pos: 30, sectionEnd: 70 },
        { level: 5, text: 'H5', pos: 40, sectionEnd: 60 },
        { level: 6, text: 'H6', pos: 50, sectionEnd: 55 },
      ];
      const provider = new OutlineViewProvider();
      provider.setOutline(deepNesting);

      // Traverse to H6
      const roots = await provider.getChildren();
      let current = roots?.[0];
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const children = await provider.getChildren(current as any);
        expect(children?.length).toBe(1);
        current = children?.[0];
      }
      expect(current?.description).toBe('H6');
    });
  });

  describe('active heading detection', () => {
    it('marks active heading based on selection position', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline(sampleOutline);
      provider.setActiveSelection(65); // Inside H2b section

      const children = await provider.getChildren();
      const h1 = children?.[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h1Children = await provider.getChildren(h1 as any);
      const h2b = h1Children?.[1];
      expect(h2b?.contextValue).toBe('outlineActive');
      expect(h1Children?.[0]?.contextValue).toBe('outlineItem');
    });

    it('clears active when selection is null', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline(sampleOutline);
      provider.setActiveSelection(null);

      const children = await provider.getChildren();
      children?.forEach(item => {
        expect(item.contextValue).toBe('outlineItem');
      });
    });

    it('finds deepest matching heading when nested', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline(sampleOutline);
      provider.setActiveSelection(25); // Inside H3 (which is inside H2, which is inside H1)

      const roots = await provider.getChildren();
      const h1 = roots?.[0];
      expect(h1?.contextValue).toBe('outlineAncestor'); // H1 is ancestor

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h1Children = await provider.getChildren(h1 as any);
      const h2 = h1Children?.[0];
      expect(h2?.contextValue).toBe('outlineAncestor'); // H2 is ancestor

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h2Children = await provider.getChildren(h2 as any);
      const h3 = h2Children?.[0];
      expect(h3?.contextValue).toBe('outlineActive'); // H3 is active
    });

    it('handles selection at exact heading position', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline(sampleOutline);
      provider.setActiveSelection(20); // Exactly at H3 start

      const roots = await provider.getChildren();
      const h1 = roots?.[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h1Children = await provider.getChildren(h1 as any);
      const h2 = h1Children?.[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h2Children = await provider.getChildren(h2 as any);
      const h3 = h2Children?.[0];
      expect(h3?.contextValue).toBe('outlineActive');
    });

    it('handles selection at section boundary', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline(sampleOutline);
      provider.setActiveSelection(29); // Just before H3 section ends

      const roots = await provider.getChildren();
      const h1 = roots?.[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h1Children = await provider.getChildren(h1 as any);
      const h2 = h1Children?.[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h2Children = await provider.getChildren(h2 as any);
      const h3 = h2Children?.[0];
      expect(h3?.contextValue).toBe('outlineActive');
    });
  });

  describe('ancestor path highlighting', () => {
    it('marks ancestors with outlineAncestor context', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline(sampleOutline);
      provider.setActiveSelection(25); // Inside H3

      const roots = await provider.getChildren();
      const h1 = roots?.[0];
      expect(h1?.contextValue).toBe('outlineAncestor');
    });

    it('does not mark siblings as ancestors', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline(sampleOutline);
      provider.setActiveSelection(25); // Inside H3

      const roots = await provider.getChildren();
      const h1 = roots?.[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h1Children = await provider.getChildren(h1 as any);
      const h2b = h1Children?.[1]; // Sibling of H2, not ancestor of H3
      expect(h2b?.contextValue).toBe('outlineItem');
    });

    it('clears ancestor path when selection changes', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline(sampleOutline);
      provider.setActiveSelection(25); // Inside H3

      // First verify H1 is ancestor
      let roots = await provider.getChildren();
      expect(roots?.[0]?.contextValue).toBe('outlineAncestor');

      // Now move to H2b (sibling branch)
      provider.setActiveSelection(65);
      roots = await provider.getChildren();
      const h1 = roots?.[0];
      expect(h1?.contextValue).toBe('outlineAncestor'); // Still ancestor

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h1Children = await provider.getChildren(h1 as any);
      expect(h1Children?.[0]?.contextValue).toBe('outlineItem'); // H2 no longer ancestor
      expect(h1Children?.[1]?.contextValue).toBe('outlineActive'); // H2b is now active
    });
  });

  describe('filtering', () => {
    it('filters headings and keeps ancestors', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline(sampleOutline);
      provider.setFilter('H3');

      const roots = await provider.getChildren();
      expect(roots?.length).toBe(1);
      const h1 = roots?.[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h1Children = await provider.getChildren(h1 as any);
      expect(h1Children?.length).toBe(1);
    });

    it('filters case-insensitively', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline(sampleOutline);
      provider.setFilter('h3');

      const roots = await provider.getChildren();
      expect(roots?.length).toBe(1);
    });

    it('shows all matching items when multiple match', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline(sampleOutline);
      provider.setFilter('H2');

      const roots = await provider.getChildren();
      const h1 = roots?.[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h1Children = await provider.getChildren(h1 as any);
      expect(h1Children?.length).toBe(2); // Both H2 and H2b match
    });

    it('clears filter correctly', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline(sampleOutline);
      provider.setFilter('H3');

      // Filter active
      let roots = await provider.getChildren();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let h1Children = await provider.getChildren(roots?.[0] as any);
      expect(h1Children?.length).toBe(1);

      // Clear filter
      provider.clearFilter();
      roots = await provider.getChildren();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      h1Children = await provider.getChildren(roots?.[0] as any);
      expect(h1Children?.length).toBe(2); // Back to full tree
    });

    it('returns original tree when filter matches nothing', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline(sampleOutline);
      provider.setFilter('nonexistent');

      // When filter matches nothing, filteredTree is empty, so falls back to original tree
      const roots = await provider.getChildren();
      expect(roots?.length).toBe(1); // Original tree still shown
    });

    it('handles partial text matches', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline([
        { level: 1, text: 'Introduction', pos: 0, sectionEnd: 50 },
        { level: 2, text: 'Getting Started', pos: 10, sectionEnd: 40 },
      ]);
      provider.setFilter('intro');

      const roots = await provider.getChildren();
      expect(roots?.length).toBe(1);
    });
  });

  describe('reveal functionality', () => {
    it('expands active node when revealing current', async () => {
      const mockView = { reveal: jest.fn() };
      const provider = new OutlineViewProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider.setTreeView(mockView as any);
      provider.setOutline(sampleOutline);
      provider.setActiveSelection(65);

      // Populate itemMap by traversing tree
      const roots = await provider.getChildren();
      const h1 = roots?.[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await provider.getChildren(h1 as any);

      provider.revealActive();

      expect(mockView.reveal).toHaveBeenCalled();
    });

    it('uses existing item from itemMap for reveal (not new instance)', async () => {
      const mockView = { reveal: jest.fn() };
      const provider = new OutlineViewProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider.setTreeView(mockView as any);
      provider.setOutline(sampleOutline);
      provider.setActiveSelection(65); // H2b position

      // Populate itemMap by calling getChildren
      const roots = await provider.getChildren();
      const h1 = roots?.[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h1Children = await provider.getChildren(h1 as any);
      const h2bItem = h1Children?.[1];

      // Call revealActive
      provider.revealActive();

      // Verify reveal was called with the SAME item instance from getChildren
      expect(mockView.reveal).toHaveBeenCalledWith(h2bItem, expect.any(Object));
    });

    it('does not reveal when no active selection', async () => {
      const mockView = { reveal: jest.fn() };
      const provider = new OutlineViewProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider.setTreeView(mockView as any);
      provider.setOutline(sampleOutline);
      provider.setActiveSelection(null);

      await provider.getChildren();
      provider.revealActive();

      expect(mockView.reveal).not.toHaveBeenCalled();
    });

    it('does not reveal when tree is empty', async () => {
      const mockView = { reveal: jest.fn() };
      const provider = new OutlineViewProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider.setTreeView(mockView as any);
      provider.setActiveSelection(10);

      provider.revealActive();

      expect(mockView.reveal).not.toHaveBeenCalled();
    });

    it('creates item for reveal when not in itemMap (supports auto-expand)', async () => {
      const mockView = { reveal: jest.fn() };
      const provider = new OutlineViewProvider();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider.setTreeView(mockView as any);
      provider.setOutline(sampleOutline);
      provider.setActiveSelection(25); // H3 position (deeply nested)

      // Only get root items, don't expand children
      await provider.getChildren();

      // Call revealActive - should create item and call reveal (enables auto-expand in collapsed mode)
      provider.revealActive();

      // Reveal should be called even though H3 wasn't in map initially
      expect(mockView.reveal).toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('handles single heading document', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline([{ level: 1, text: 'Only Heading', pos: 0, sectionEnd: 100 }]);

      const roots = await provider.getChildren();
      expect(roots?.length).toBe(1);
      expect(roots?.[0]?.collapsibleState).toBe(0); // None (no children)
    });

    it('handles skipped heading levels (H1 > H3)', async () => {
      const skipped: OutlineEntry[] = [
        { level: 1, text: 'H1', pos: 0, sectionEnd: 100 },
        { level: 3, text: 'H3', pos: 10, sectionEnd: 50 }, // Skipped H2
      ];
      const provider = new OutlineViewProvider();
      provider.setOutline(skipped);

      const roots = await provider.getChildren();
      expect(roots?.length).toBe(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h1Children = await provider.getChildren(roots?.[0] as any);
      expect(h1Children?.length).toBe(1);
      expect(h1Children?.[0]?.description).toBe('H3');
    });

    it('handles selection outside all sections', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline(sampleOutline);
      provider.setActiveSelection(1000); // Way outside

      const roots = await provider.getChildren();
      roots?.forEach(item => {
        expect(item.contextValue).toBe('outlineItem');
      });
    });

    it('handles rapid outline updates', async () => {
      const provider = new OutlineViewProvider();

      // Rapid updates
      provider.setOutline(sampleOutline);
      provider.setOutline([{ level: 1, text: 'New', pos: 0, sectionEnd: 10 }]);
      provider.setOutline(sampleOutline);

      const roots = await provider.getChildren();
      expect(roots?.length).toBe(1);
    });

    it('handles special characters in heading text', async () => {
      const provider = new OutlineViewProvider();
      provider.setOutline([
        { level: 1, text: 'Code: `function()`', pos: 0, sectionEnd: 50 },
        { level: 2, text: 'Emoji 🎉 heading', pos: 10, sectionEnd: 40 },
      ]);

      const roots = await provider.getChildren();
      expect(roots?.length).toBe(1);
      provider.setFilter('emoji');
      const filtered = await provider.getChildren();
      expect(filtered?.length).toBe(1);
    });
  });
});

describe('OutlineViewProvider localization', () => {
  const translate = vscode.l10n.t as jest.Mock;
  const englishTranslate = translate.getMockImplementation();
  const windowApi = vscode.window as unknown as { createQuickPick?: jest.Mock };
  // Leaves out "Go to heading" on purpose, to exercise the fallback to English.
  const sampleBundle: Record<string, string> = {
    '(Untitled)': '（无标题）',
    'H{0}': '标题{0}',
    'Type to filter headings... (X to clear, Esc to close)':
      '输入以筛选标题...（按 X 清除，按 Esc 关闭）',
  };

  beforeEach(() => {
    translate.mockImplementation((message: string, ...args: Array<string | number | boolean>) =>
      (sampleBundle[message] ?? message).replace(/\{(\d+)\}/g, (placeholder, index: string) =>
        args[Number(index)] === undefined ? placeholder : String(args[Number(index)])
      )
    );
  });

  afterEach(() => {
    translate.mockImplementation(englishTranslate);
    delete windowApi.createQuickPick;
  });

  it('shows the translated label and level badge', async () => {
    const provider = new OutlineViewProvider();
    provider.setOutline([{ level: 2, text: '', pos: 7, sectionEnd: 10 }]);

    const [item] = (await provider.getChildren()) ?? [];

    expect(item.label).toBe('（无标题）');
    expect(item.description).toBe('标题2');
    expect(item.command?.title).toBe('Go to heading');
  });

  it('keeps heading text as written and translates the filter placeholder', async () => {
    const quickPick = {
      placeholder: '',
      value: '',
      onDidChangeValue: jest.fn(),
      onDidHide: jest.fn(),
      onDidAccept: jest.fn(),
      show: jest.fn(),
    };
    windowApi.createQuickPick = jest.fn(() => quickPick);
    const provider = new OutlineViewProvider();
    provider.setOutline([{ level: 1, text: 'Overview', pos: 0, sectionEnd: 10 }]);

    const [item] = (await provider.getChildren()) ?? [];
    provider.showFilterInput();

    expect(item.label).toBe('Overview');
    expect(quickPick.placeholder).toBe('输入以筛选标题...（按 X 清除，按 Esc 关闭）');
  });
});
