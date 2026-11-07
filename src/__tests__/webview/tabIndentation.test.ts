/**
 * Tests for Tab indentation support - Comprehensive Coverage
 *
 * Testing strategy per AGENTS.md:
 * - Positive cases (expected behavior)
 * - Negative cases (error handling)
 * - Edge cases (boundary conditions)
 */

describe('Tab Indentation Extension', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let TabIndentation: any;
  let nodeSelectionPrototype: object;

  beforeEach(async () => {
    jest.resetModules();
    ({
      NodeSelection: { prototype: nodeSelectionPrototype },
    } = await import('@tiptap/pm/state'));
    ({ TabIndentation } = await import('../../webview/extensions/tabIndentation'));
  });

  describe('Tab Key - Tables', () => {
    it('should delegate to Table extension (return false)', () => {
      const mockEditor = {
        view: { state: { selection: {} } },
        isActive: jest.fn(name => name === 'table'),
        commands: {},
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Tab']();

      expect(result).toBe(false);
      expect(mockEditor.isActive).toHaveBeenCalledWith('table');
    });
  });

  describe('Tab Key - Code Blocks', () => {
    it('should delegate to CodeBlockLowlight extension (return false)', () => {
      const mockEditor = {
        view: { state: { selection: {} } },
        isActive: jest.fn(name => name === 'codeBlock'),
        commands: {},
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Tab']();

      expect(result).toBe(false);
      expect(mockEditor.isActive).toHaveBeenCalledWith('codeBlock');
    });
  });

  describe('Tab Key - Lists (Bullet and Numbered)', () => {
    it('should indent list item when has previous sibling', () => {
      const sinkMock = jest.fn(() => true); // Successful indent
      const insertMock = jest.fn();
      const mockEditor = {
        view: { state: { selection: {} } },
        isActive: jest.fn(name => name === 'listItem'),
        commands: {
          sinkListItem: sinkMock,
          insertContent: insertMock,
        },
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Tab']();

      expect(result).toBe(true);
      expect(sinkMock).toHaveBeenCalledWith('listItem');
      expect(sinkMock).toHaveBeenCalledWith('taskItem');
      expect(insertMock).not.toHaveBeenCalled();
    });

    it('should not insert tab when first item (no previous sibling)', () => {
      const sinkMock = jest.fn(() => false); // Failed indent
      const insertMock = jest.fn();
      const mockEditor = {
        view: { state: { selection: {} } },
        isActive: jest.fn(name => name === 'listItem'),
        commands: {
          sinkListItem: sinkMock,
          insertContent: insertMock,
        },
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Tab']();

      expect(result).toBe(true); // Prevents focus loss
      expect(sinkMock).toHaveBeenCalled();
      expect(insertMock).not.toHaveBeenCalled(); // Critical: no tab insertion
    });

    it('should not insert tab when at max nesting depth', () => {
      const sinkMock = jest.fn(() => false); // Failed indent (max depth)
      const insertMock = jest.fn();
      const mockEditor = {
        view: { state: { selection: {} } },
        isActive: jest.fn(name => name === 'listItem'),
        commands: {
          sinkListItem: sinkMock,
          insertContent: insertMock,
        },
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Tab']();

      expect(result).toBe(true);
      expect(insertMock).not.toHaveBeenCalled();
    });
  });

  describe('Tab Key - Task Lists', () => {
    it('should indent task item when has previous sibling', () => {
      const sinkMock = jest.fn(() => true);
      const mockEditor = {
        view: { state: { selection: {} } },
        isActive: jest.fn(name => name === 'taskItem'),
        commands: {
          sinkListItem: sinkMock,
        },
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Tab']();

      expect(result).toBe(true);
      expect(sinkMock).toHaveBeenCalledWith('taskItem');
    });

    it('should not insert tab when first task item', () => {
      const sinkMock = jest.fn(() => false);
      const insertMock = jest.fn();
      const mockEditor = {
        view: { state: { selection: {} } },
        isActive: jest.fn(name => name === 'taskItem'),
        commands: {
          sinkListItem: sinkMock,
          insertContent: insertMock,
        },
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Tab']();

      expect(result).toBe(true);
      expect(insertMock).not.toHaveBeenCalled();
    });
  });

  describe('Tab Key - Paragraphs and Headings', () => {
    it('should insert tab in paragraph', () => {
      const insertMock = jest.fn();
      const mockEditor = {
        view: { state: { selection: {} } },
        isActive: jest.fn(name => name === 'paragraph'),
        commands: {
          insertContent: insertMock,
        },
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Tab']();

      expect(result).toBe(true);
      expect(insertMock).toHaveBeenCalledWith('\t');
    });

    it('should insert tab in heading', () => {
      const insertMock = jest.fn();
      const mockEditor = {
        view: { state: { selection: {} } },
        isActive: jest.fn(name => name === 'heading'),
        commands: {
          insertContent: insertMock,
        },
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Tab']();

      expect(result).toBe(true);
      expect(insertMock).toHaveBeenCalledWith('\t');
    });

    it('should insert tab in empty paragraph', () => {
      const insertMock = jest.fn();
      const mockEditor = {
        view: { state: { selection: {} } },
        isActive: jest.fn(() => false), // No specific context
        commands: {
          insertContent: insertMock,
        },
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Tab']();

      expect(result).toBe(true);
      expect(insertMock).toHaveBeenCalledWith('\t');
    });
  });

  describe('Tab Key - Images (NodeSelection)', () => {
    it('should insert tab when image is selected', () => {
      const insertMock = jest.fn();
      const mockEditor = {
        view: {
          state: {
            selection: Object.create(nodeSelectionPrototype),
          },
        },
        isActive: jest.fn(() => false),
        commands: {
          insertContent: insertMock,
        },
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Tab']();

      expect(result).toBe(true);
      expect(insertMock).toHaveBeenCalledWith('\t');
    });
  });

  describe('Shift+Tab Key - Images', () => {
    it('should outdent selected image by removing one tab from indent-prefix', () => {
      const updateAttributesMock = jest.fn();
      const selection = Object.create(nodeSelectionPrototype);
      selection.node = {
        type: { name: 'image' },
        attrs: { 'indent-prefix': '\t\t' },
      };

      const mockEditor = {
        view: { state: { selection } },
        isActive: jest.fn(() => false),
        commands: {
          updateAttributes: updateAttributesMock,
        },
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Shift-Tab']();

      expect(result).toBe(true);
      expect(updateAttributesMock).toHaveBeenCalledWith('image', { 'indent-prefix': '\t' });
    });

    it('should outdent image before cursor at line start (without needing node selection)', () => {
      const updateAttributesMock = jest.fn();
      const setNodeSelectionMock = jest.fn();
      const selection = {
        empty: true,
        $from: {
          pos: 12,
          parentOffset: 0,
          parent: { textContent: '' },
          nodeBefore: null,
          nodeAfter: {
            type: { name: 'image' },
            attrs: { 'indent-prefix': '    ' },
          },
        },
      };

      const mockEditor = {
        view: { state: { selection } },
        isActive: jest.fn(() => false),
        commands: {
          setNodeSelection: setNodeSelectionMock,
          updateAttributes: updateAttributesMock,
        },
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Shift-Tab']();

      expect(result).toBe(true);
      expect(setNodeSelectionMock).toHaveBeenCalledWith(12);
      expect(updateAttributesMock).toHaveBeenCalledWith('image', { 'indent-prefix': null });
    });
  });

  describe('Shift+Tab Key - Tables', () => {
    it('should delegate to Table extension (return false)', () => {
      const mockEditor = {
        view: { state: { selection: {} } },
        isActive: jest.fn(name => name === 'table'),
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      expect(shortcuts['Shift-Tab']()).toBe(false);
    });
  });

  describe('Shift+Tab Key - Code Blocks', () => {
    it('should delegate to CodeBlockLowlight extension (return false)', () => {
      const mockEditor = {
        view: { state: { selection: {} } },
        isActive: jest.fn(name => name === 'codeBlock'),
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      expect(shortcuts['Shift-Tab']()).toBe(false);
    });
  });

  describe('Shift+Tab Key - Lists', () => {
    it('should outdent nested list item', () => {
      const liftMock = jest.fn(() => true);
      const mockEditor = {
        view: { state: { selection: {} } },
        isActive: jest.fn(name => name === 'listItem'),
        commands: { liftListItem: liftMock },
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      expect(shortcuts['Shift-Tab']()).toBe(true);
      expect(liftMock).toHaveBeenCalledWith('listItem');
    });

    it('should convert top-level list item to paragraph', () => {
      const liftMock = jest.fn(() => true); // Converts to paragraph
      const mockEditor = {
        view: { state: { selection: {} } },
        isActive: jest.fn(name => name === 'listItem'),
        commands: { liftListItem: liftMock },
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      expect(shortcuts['Shift-Tab']()).toBe(true);
      expect(liftMock).toHaveBeenCalledWith('listItem');
      expect(liftMock).toHaveBeenCalledWith('taskItem');
    });
  });

  describe('Shift+Tab Key - Paragraphs (Smart Removal)', () => {
    it('should remove leading tab character', () => {
      const dispatchMock = jest.fn();
      const mockState = {
        selection: {
          $from: {
            pos: 5,
            parentOffset: 2,
            parent: {
              textContent: '\tHello world',
            },
          },
        },
        tr: {
          delete: jest.fn().mockReturnThis(),
        },
      };

      const mockEditor = {
        view: {
          state: mockState,
          dispatch: dispatchMock,
        },
        isActive: jest.fn(() => false),
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Shift-Tab']();

      expect(result).toBe(true);
      expect(mockState.tr.delete).toHaveBeenCalled();
      expect(dispatchMock).toHaveBeenCalled();
    });

    it('should remove leading spaces (up to 4)', () => {
      const dispatchMock = jest.fn();
      const mockState = {
        selection: {
          $from: {
            pos: 8,
            parentOffset: 4,
            parent: {
              textContent: '    Hello world',
            },
          },
        },
        tr: {
          delete: jest.fn().mockReturnThis(),
        },
      };

      const mockEditor = {
        view: {
          state: mockState,
          dispatch: dispatchMock,
        },
        isActive: jest.fn(() => false),
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Shift-Tab']();

      expect(result).toBe(true);
      expect(mockState.tr.delete).toHaveBeenCalled();
    });

    it('should do nothing when no leading whitespace', () => {
      const dispatchMock = jest.fn();
      const mockState = {
        selection: {
          $from: {
            pos: 8,
            parentOffset: 5,
            parent: {
              textContent: 'Hello world',
            },
          },
        },
        tr: {
          delete: jest.fn().mockReturnThis(),
        },
      };

      const mockEditor = {
        view: {
          state: mockState,
          dispatch: dispatchMock,
        },
        isActive: jest.fn(() => false),
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Shift-Tab']();

      expect(result).toBe(true); // Still prevents focus loss
      expect(mockState.tr.delete).not.toHaveBeenCalled();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it('should do nothing on empty line', () => {
      const dispatchMock = jest.fn();
      const mockState = {
        selection: {
          $from: {
            pos: 0,
            parentOffset: 0,
            parent: {
              textContent: '',
            },
          },
        },
        tr: {
          delete: jest.fn().mockReturnThis(),
        },
      };

      const mockEditor = {
        view: {
          state: mockState,
          dispatch: dispatchMock,
        },
        isActive: jest.fn(() => false),
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Shift-Tab']();

      expect(result).toBe(true);
      expect(mockState.tr.delete).not.toHaveBeenCalled();
    });
  });

  describe('Edge Cases - Focus Loss Prevention', () => {
    it('should always return true in lists to prevent focus loss', () => {
      const sinkMock = jest.fn(() => false);
      const mockEditor = {
        view: { state: { selection: {} } },
        isActive: jest.fn(name => name === 'listItem'),
        commands: { sinkListItem: sinkMock },
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Tab']();

      expect(result).toBe(true); // Critical for UX
    });

    it('should always return true in paragraphs for Shift+Tab', () => {
      const mockEditor = {
        view: {
          state: {
            selection: {
              $from: {
                pos: 0,
                parentOffset: 0,
                parent: { textContent: 'No indent' },
              },
            },
            tr: { delete: jest.fn().mockReturnThis() },
          },
          dispatch: jest.fn(),
        },
        isActive: jest.fn(() => false),
      };

      const shortcuts = TabIndentation.config.addKeyboardShortcuts.call({ editor: mockEditor });
      const result = shortcuts['Shift-Tab']();

      expect(result).toBe(true); // Prevents focus loss even when no action
    });
  });
});
