/**
 * @jest-environment jsdom
 */

/**
 * Tests for BubbleMenuView toolbar and menu components
 */

import type { Editor } from '@tiptap/core';

// Mock the imports
jest.mock('../../webview/mermaidTemplates', () => ({
  MERMAID_TEMPLATES: [{ label: 'Flowchart', diagram: 'graph TD\nA-->B' }],
}));

jest.mock('../../webview/features/tableInsert', () => ({
  showTableInsertDialog: jest.fn(),
}));

jest.mock('../../webview/features/linkDialog', () => ({
  showLinkDialog: jest.fn(),
}));

jest.mock('../../webview/features/imageInsertDialog', () => ({
  showImageInsertDialog: jest.fn().mockResolvedValue(undefined),
}));

describe('BubbleMenuView', () => {
  let createFormattingToolbar: (editor: Editor) => HTMLElement;
  let createTableMenu: (editor: Editor) => HTMLElement;
  let updateToolbarStates: () => void;
  let getFeedbackToolbarMenuHost:
    ((trigger: HTMLElement | null, fallback: HTMLElement) => HTMLElement) | undefined;
  let setFeedbackToolbarState: (state: {
    active: boolean;
    count?: number;
    commentsVisible?: boolean;
    commentsState?: 'hidden' | 'collapsed' | 'expanded';
    commentsLocked?: boolean;
    invalidated?: boolean;
    starting?: boolean;
    closing?: boolean;
    captureState?: 'idle' | 'armed' | 'rasterizing';
  }) => void;

  beforeEach(async () => {
    jest.resetModules();
    document.body.innerHTML = '';

    // Import after mocks are set up
    const module = await import('../../webview/BubbleMenuView');
    createFormattingToolbar = module.createFormattingToolbar;
    createTableMenu = module.createTableMenu;
    updateToolbarStates = module.updateToolbarStates;
    setFeedbackToolbarState = module.setFeedbackToolbarState;
    getFeedbackToolbarMenuHost = (
      module as typeof module & {
        getFeedbackToolbarMenuHost?: (
          trigger: HTMLElement | null,
          fallback: HTMLElement
        ) => HTMLElement;
      }
    ).getFeedbackToolbarMenuHost;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const createMockEditor = () => {
    const chain = jest.fn(() => ({
      focus: jest.fn().mockReturnThis(),
      toggleBold: jest.fn().mockReturnThis(),
      toggleItalic: jest.fn().mockReturnThis(),
      toggleStrike: jest.fn().mockReturnThis(),
      toggleCode: jest.fn().mockReturnThis(),
      toggleHeading: jest.fn().mockReturnThis(),
      toggleBulletList: jest.fn().mockReturnThis(),
      toggleOrderedList: jest.fn().mockReturnThis(),
      toggleTaskList: jest.fn().mockReturnThis(),
      toggleBlockquote: jest.fn().mockReturnThis(),
      setCodeBlock: jest.fn().mockReturnThis(),
      insertTable: jest.fn().mockReturnThis(),
      insertContent: jest.fn().mockReturnThis(),
      addRowBefore: jest.fn().mockReturnThis(),
      addRowAfter: jest.fn().mockReturnThis(),
      deleteRow: jest.fn().mockReturnThis(),
      addColumnBefore: jest.fn().mockReturnThis(),
      addColumnAfter: jest.fn().mockReturnThis(),
      deleteColumn: jest.fn().mockReturnThis(),
      deleteTable: jest.fn().mockReturnThis(),
      run: jest.fn(),
    }));

    return {
      chain,
      isActive: jest.fn().mockReturnValue(false),
      on: jest.fn(), // Event listener registration
      off: jest.fn(), // Event listener removal
      state: {
        selection: { from: 0, to: 0 },
        doc: { textBetween: jest.fn().mockReturnValue('') },
      },
      view: {
        dom: document.createElement('div'),
      },
    } as unknown as Editor;
  };

  describe('createFormattingToolbar', () => {
    it('creates a toolbar element with correct class', () => {
      const editor = createMockEditor();
      const toolbar = createFormattingToolbar(editor);

      expect(toolbar).toBeInstanceOf(HTMLElement);
      expect(toolbar.className).toBe('formatting-toolbar');
    });

    it('contains formatting buttons', () => {
      const editor = createMockEditor();
      const toolbar = createFormattingToolbar(editor);

      // Check for essential buttons
      const buttons = toolbar.querySelectorAll('button');
      expect(buttons.length).toBeGreaterThan(0);
    });

    it('registers selection update listener', () => {
      const editor = createMockEditor();
      createFormattingToolbar(editor);

      // Toolbar should register for selection updates
      expect(editor.on).toHaveBeenCalledWith('selectionUpdate', expect.any(Function));
    });

    it('shows Start feedback in normal mode and only review actions in feedback mode', () => {
      const editor = createMockEditor();
      const toolbar = createFormattingToolbar(editor);

      expect(toolbar.querySelector('[data-feedback-start]')).toBeTruthy();
      expect(toolbar.querySelector('[data-feedback-finish]')).toBeNull();

      setFeedbackToolbarState({ active: true, count: 3, commentsVisible: true });

      expect(toolbar.querySelector('[data-feedback-start]')).toBeNull();
      expect(toolbar.querySelector('[data-feedback-finish]')?.textContent).toContain(
        'Finish & copy'
      );
      expect(toolbar.querySelector('[data-feedback-capture]')).toBeTruthy();
      expect(toolbar.querySelector('[data-feedback-comments]')?.textContent).toContain('3');
      expect(toolbar.querySelectorAll('.toolbar-button:not([data-feedback-action])')).toHaveLength(
        0
      );
    });

    it('mounts review actions as one centered group and restores the normal toolbar cleanly', () => {
      const editor = createMockEditor();
      const toolbar = createFormattingToolbar(editor);

      setFeedbackToolbarState({ active: true, count: 3, commentsState: 'collapsed' });

      const group = toolbar.querySelector('[data-feedback-toolbar-group]');
      expect(group).not.toBeNull();
      expect(group?.getAttribute('role')).toBe('group');
      expect(group?.getAttribute('aria-label')).toBe('Feedback session actions');
      expect(group?.querySelectorAll('[data-feedback-action]')).toHaveLength(4);
      expect(group?.lastElementChild?.hasAttribute('data-feedback-more')).toBe(true);
      expect(toolbar.children).toHaveLength(1);
      expect(toolbar.classList).toContain('feedback-toolbar-active');

      setFeedbackToolbarState({ active: false });

      expect(toolbar.querySelector('[data-feedback-toolbar-group]')).toBeNull();
      expect(toolbar.classList).not.toContain('feedback-toolbar-active');
      expect(toolbar.querySelector('[data-feedback-start]')).not.toBeNull();
    });

    it('uses the centered action group as the More menu positioning host', () => {
      const fallback = document.createElement('div');
      const group = document.createElement('div');
      group.setAttribute('data-feedback-toolbar-group', '');
      const trigger = document.createElement('button');
      group.append(trigger);
      fallback.append(group);

      expect(getFeedbackToolbarMenuHost).toBeDefined();
      expect(getFeedbackToolbarMenuHost?.(trigger, fallback)).toBe(group);
      expect(getFeedbackToolbarMenuHost?.(null, fallback)).toBe(fallback);
    });

    it('moves focus from Start feedback to Finish & copy when feedback mode activates', () => {
      const editor = createMockEditor();
      const toolbar = createFormattingToolbar(editor);
      document.body.append(toolbar);
      const start = toolbar.querySelector('[data-feedback-start]') as HTMLButtonElement;
      start.focus();
      expect(document.activeElement).toBe(start);

      setFeedbackToolbarState({ active: true, count: 0, commentsState: 'collapsed' });

      const finish = toolbar.querySelector('[data-feedback-finish]') as HTMLButtonElement;
      expect(document.activeElement).toBe(finish);
    });

    it.each([
      {
        commentsState: 'hidden' as const,
        ariaPressed: 'false',
        ariaExpanded: 'false',
        active: false,
        icon: 'codicon-layout-sidebar-right-off',
      },
      {
        commentsState: 'collapsed' as const,
        ariaPressed: 'true',
        ariaExpanded: 'false',
        active: false,
        icon: 'codicon-comment-discussion-sparkle',
      },
      {
        commentsState: 'expanded' as const,
        ariaPressed: 'true',
        ariaExpanded: 'true',
        active: true,
        icon: 'codicon-comment-discussion-sparkle',
      },
    ])(
      'renders the $commentsState comments state with matching visual and accessible state',
      ({ commentsState, ariaPressed, ariaExpanded, active, icon }) => {
        const editor = createMockEditor();
        const toolbar = createFormattingToolbar(editor);

        setFeedbackToolbarState({ active: true, count: 6, commentsState });

        const comments = toolbar.querySelector('[data-feedback-comments]') as HTMLButtonElement;
        expect(comments.getAttribute('data-feedback-comments-state')).toBe(commentsState);
        expect(comments.getAttribute('aria-pressed')).toBe(ariaPressed);
        expect(comments.getAttribute('aria-expanded')).toBe(ariaExpanded);
        expect(comments.getAttribute('aria-controls')).toBe('feedback-comments-rail');
        expect(comments.classList.contains('active')).toBe(active);
        expect(comments.querySelector('.toolbar-icon')?.classList).toContain(icon);
        expect(comments.textContent).toContain('Comments · 6');
      }
    );

    it('keeps the comment count stable while moving through all comments states', () => {
      const editor = createMockEditor();
      const toolbar = createFormattingToolbar(editor);

      for (const commentsState of ['hidden', 'collapsed', 'expanded'] as const) {
        setFeedbackToolbarState({ active: true, count: 6, commentsState });
        const comments = toolbar.querySelector('[data-feedback-comments]') as HTMLButtonElement;
        expect(comments.textContent).toContain('Comments · 6');
        expect(comments.getAttribute('data-feedback-comments-state')).toBe(commentsState);
      }
    });

    it('preserves Comments button focus when its state or count rerenders', () => {
      const editor = createMockEditor();
      const toolbar = createFormattingToolbar(editor);
      document.body.append(toolbar);
      setFeedbackToolbarState({ active: true, count: 6, commentsState: 'collapsed' });

      let comments = toolbar.querySelector('[data-feedback-comments]') as HTMLButtonElement;
      comments.focus();
      expect(document.activeElement).toBe(comments);

      setFeedbackToolbarState({ active: true, count: 6, commentsState: 'expanded' });
      comments = toolbar.querySelector('[data-feedback-comments]') as HTMLButtonElement;
      expect(document.activeElement).toBe(comments);

      setFeedbackToolbarState({ active: true, count: 7, commentsState: 'expanded' });
      comments = toolbar.querySelector('[data-feedback-comments]') as HTMLButtonElement;
      expect(document.activeElement).toBe(comments);
      expect(comments.textContent).toContain('Comments · 7');

      setFeedbackToolbarState({ active: true, count: 7, commentsState: 'hidden' });
      comments = toolbar.querySelector('[data-feedback-comments]') as HTMLButtonElement;
      expect(document.activeElement).toBe(comments);
    });

    it('explains that expanded comments remain open while feedback is being added', () => {
      const editor = createMockEditor();
      const toolbar = createFormattingToolbar(editor);

      setFeedbackToolbarState({
        active: true,
        count: 2,
        commentsState: 'expanded',
        commentsLocked: true,
      });

      const comments = toolbar.querySelector('[data-feedback-comments]') as HTMLButtonElement;
      expect(comments.getAttribute('data-feedback-comments-state')).toBe('expanded');
      expect(comments.getAttribute('aria-pressed')).toBe('true');
      expect(comments.getAttribute('aria-expanded')).toBe('true');
      expect(comments.classList).toContain('active');
      expect(comments.getAttribute('aria-label')).toBe(
        'Comments remain open while adding feedback, 2 saved'
      );
      expect(comments.title).toBe('Comments remain open while adding feedback, 2 saved');
      expect(comments.textContent).toContain('Comments · 2');
    });

    it('disables finish and capture when the frozen source is invalidated', () => {
      const editor = createMockEditor();
      const toolbar = createFormattingToolbar(editor);
      setFeedbackToolbarState({ active: true, invalidated: true });

      expect((toolbar.querySelector('[data-feedback-finish]') as HTMLButtonElement).disabled).toBe(
        true
      );
      expect((toolbar.querySelector('[data-feedback-capture]') as HTMLButtonElement).disabled).toBe(
        true
      );
    });

    it('marks Start feedback disabled and busy while a session is starting', () => {
      const editor = createMockEditor();
      const toolbar = createFormattingToolbar(editor);

      setFeedbackToolbarState({ active: false, starting: true });

      const start = toolbar.querySelector('[data-feedback-start]') as HTMLButtonElement;
      expect(start.disabled).toBe(true);
      expect(start.getAttribute('aria-disabled')).toBe('true');
      expect(start.getAttribute('aria-busy')).toBe('true');

      setFeedbackToolbarState({ active: false, starting: false });
      expect(start.disabled).toBe(false);
      expect(start.getAttribute('aria-busy')).toBe('false');
    });

    it('locks every normal toolbar action while a Feedback transition is starting', () => {
      const editor = createMockEditor();
      const toolbar = createFormattingToolbar(editor);

      setFeedbackToolbarState({ active: false, starting: true });

      expect(toolbar.getAttribute('aria-busy')).toBe('true');
      expect(
        Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button')).every(
          button => button.disabled
        )
      ).toBe(true);

      setFeedbackToolbarState({ active: false, starting: false });

      expect(toolbar.getAttribute('aria-busy')).toBe('false');
      expect((toolbar.querySelector('[data-feedback-start]') as HTMLButtonElement).disabled).toBe(
        false
      );
    });

    it('marks the Feedback action group busy and disables every action while closing', () => {
      const editor = createMockEditor();
      const toolbar = createFormattingToolbar(editor);

      setFeedbackToolbarState({ active: true, count: 2, closing: true });

      const group = toolbar.querySelector<HTMLElement>('[data-feedback-toolbar-group]');
      const controls = Array.from(
        group?.querySelectorAll<HTMLButtonElement>('[data-feedback-action]') ?? []
      );
      expect(group?.getAttribute('aria-busy')).toBe('true');
      expect(controls).toHaveLength(4);
      expect(controls.every(control => control.disabled)).toBe(true);
      expect(controls.every(control => control.getAttribute('aria-disabled') === 'true')).toBe(
        true
      );

      setFeedbackToolbarState({ active: true, count: 2, closing: false });

      const unlockedGroup = toolbar.querySelector<HTMLElement>('[data-feedback-toolbar-group]');
      expect(unlockedGroup?.getAttribute('aria-busy')).toBe('false');
      expect(
        Array.from(
          unlockedGroup?.querySelectorAll<HTMLButtonElement>('[data-feedback-action]') ?? []
        ).every(control => !control.disabled)
      ).toBe(true);
    });

    it('renders an armed area capture as the only available Cancel capture action', () => {
      const editor = createMockEditor();
      const toolbar = createFormattingToolbar(editor);

      setFeedbackToolbarState({
        active: true,
        count: 2,
        commentsState: 'collapsed',
        captureState: 'armed',
      });

      const group = toolbar.querySelector<HTMLElement>('[data-feedback-toolbar-group]');
      const capture = toolbar.querySelector<HTMLButtonElement>('[data-feedback-capture]');
      const siblingControls = Array.from(
        toolbar.querySelectorAll<HTMLButtonElement>('[data-feedback-action]')
      ).filter(control => control !== capture);

      expect(capture?.textContent).toContain('Cancel capture');
      expect(capture?.querySelector('.toolbar-icon')?.classList).toContain('codicon-close');
      expect(capture?.classList).toContain('active');
      expect(capture?.getAttribute('aria-pressed')).toBe('true');
      expect(capture?.getAttribute('aria-label')).toBe('Cancel area capture');
      expect(capture?.title).toBe('Cancel area capture');
      expect(capture?.disabled).toBe(false);
      expect(siblingControls.every(control => control.disabled)).toBe(true);
      expect(group?.getAttribute('aria-busy')).toBe('false');
    });

    it('dispatches an explicit cancel event instead of starting another capture while armed', () => {
      const editor = createMockEditor();
      const toolbar = createFormattingToolbar(editor);
      const startRequested = jest.fn();
      const cancelRequested = jest.fn();
      window.addEventListener('feedbackCaptureRequested', startRequested);
      window.addEventListener('feedbackCaptureCancelRequested', cancelRequested);

      try {
        setFeedbackToolbarState({ active: true, captureState: 'armed' });
        toolbar.querySelector<HTMLButtonElement>('[data-feedback-capture]')?.click();

        expect(cancelRequested).toHaveBeenCalledTimes(1);
        expect(startRequested).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('feedbackCaptureRequested', startRequested);
        window.removeEventListener('feedbackCaptureCancelRequested', cancelRequested);
      }
    });

    it('marks rasterization busy and disables every Feedback action', () => {
      const editor = createMockEditor();
      const toolbar = createFormattingToolbar(editor);

      setFeedbackToolbarState({ active: true, count: 2, captureState: 'rasterizing' });

      const group = toolbar.querySelector<HTMLElement>('[data-feedback-toolbar-group]');
      const controls = Array.from(
        toolbar.querySelectorAll<HTMLButtonElement>('[data-feedback-action]')
      );
      const capture = toolbar.querySelector<HTMLButtonElement>('[data-feedback-capture]');

      expect(group?.getAttribute('aria-busy')).toBe('true');
      expect(capture?.textContent).toContain('Preparing capture…');
      expect(capture?.getAttribute('aria-busy')).toBe('true');
      expect(controls.every(control => control.disabled)).toBe(true);
    });

    it('preserves logical capture focus while its armed state rerenders', () => {
      const editor = createMockEditor();
      const toolbar = createFormattingToolbar(editor);
      document.body.append(toolbar);
      setFeedbackToolbarState({ active: true, captureState: 'idle' });
      const initialCapture = toolbar.querySelector<HTMLButtonElement>('[data-feedback-capture]')!;
      initialCapture.focus();

      setFeedbackToolbarState({ active: true, captureState: 'armed' });

      const armedCapture = toolbar.querySelector<HTMLButtonElement>('[data-feedback-capture]')!;
      expect(armedCapture).not.toBe(initialCapture);
      expect(document.activeElement).toBe(armedCapture);

      setFeedbackToolbarState({ active: true, captureState: 'idle' });
      expect(document.activeElement).toBe(
        toolbar.querySelector<HTMLButtonElement>('[data-feedback-capture]')
      );
    });
  });

  describe('createTableMenu', () => {
    it('creates a hidden menu element', () => {
      const editor = createMockEditor();
      const menu = createTableMenu(editor);

      expect(menu).toBeInstanceOf(HTMLElement);
      expect(menu.className).toBe('table-menu');
      expect(menu.style.display).toBe('none');
    });

    it('contains table operation items', () => {
      const editor = createMockEditor();
      const menu = createTableMenu(editor);

      const items = menu.querySelectorAll('.table-menu-item');
      expect(items.length).toBeGreaterThan(0);

      // Check for specific operations
      const addRowItem = Array.from(items).find(item => item.textContent?.includes('Add Row'));
      expect(addRowItem).toBeTruthy();
    });

    it('calls editor commands on item click', () => {
      const editor = createMockEditor();
      const menu = createTableMenu(editor);

      const items = menu.querySelectorAll('.table-menu-item');
      const firstItem = items[0] as HTMLElement;

      if (firstItem) {
        firstItem.click();
        expect(editor.chain).toHaveBeenCalled();
      }
    });

    it('hides menu after item click', () => {
      const editor = createMockEditor();
      const menu = createTableMenu(editor);

      menu.style.display = 'block';

      const items = menu.querySelectorAll('.table-menu-item');
      const firstItem = items[0] as HTMLElement;

      if (firstItem) {
        firstItem.click();
        expect(menu.style.display).toBe('none');
      }
    });
  });

  describe('updateToolbarStates', () => {
    it('can be called without error when no toolbar exists', () => {
      expect(() => updateToolbarStates()).not.toThrow();
    });
  });
});
