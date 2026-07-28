/**
 * Mock VS Code API for unit testing
 *
 * This provides minimal mocks for VS Code APIs used in our extension.
 * For integration tests that need real VS Code, use @vscode/test-electron.
 */

// Type definitions for mocks
export interface MockUri {
  fsPath: string;
  path: string;
  scheme: string;
  toString?: () => string;
  uri?: string;
}

export interface MockRange {
  start: Position;
  end: Position;
}

export interface MockTextDocument {
  getText(range?: MockRange): string;
  languageId: string;
  uri: MockUri;
  fileName: string;
  lineCount: number;
  lineAt(line: number): { text: string; lineNumber: number };
}

export interface MockTextEditor {
  document: MockTextDocument;
  selection: Selection;
  selections: Selection[];
}

// Mock StatusBarItem
export const mockStatusBarItem = {
  text: '',
  tooltip: '',
  command: undefined as string | undefined,
  show: jest.fn(),
  hide: jest.fn(),
  dispose: jest.fn(),
};

// Mock StatusBarAlignment enum
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

// Mock window API
export const window = {
  createStatusBarItem: jest.fn(() => mockStatusBarItem),
  activeTextEditor: undefined as unknown,
  showErrorMessage: jest.fn(),
  showInformationMessage: jest.fn(),
  showWarningMessage: jest.fn(),
  onDidChangeActiveTextEditor: jest.fn(() => ({ dispose: jest.fn() })),
  onDidChangeTextEditorSelection: jest.fn(() => ({ dispose: jest.fn() })),
  withProgress: jest.fn((_options, task) => {
    return task(
      {
        report: jest.fn(),
      },
      { isCancellationRequested: false, onCancellationRequested: jest.fn() }
    );
  }),
  showSaveDialog: jest.fn(),
  showOpenDialog: jest.fn(),
  activeColorTheme: { kind: 2 }, // ColorThemeKind.Dark
  onDidChangeActiveColorTheme: jest.fn(() => ({ dispose: jest.fn() })),
};

// Mock workspace API
export const workspace = {
  onDidChangeTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
  getWorkspaceFolder: jest.fn(),
  workspaceFolders: undefined as Array<{ uri: MockUri; name: string; index: number }> | undefined,
  getConfiguration: jest.fn(() => ({
    get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
    update: jest.fn(),
  })),
  applyEdit: jest.fn(async (_edit?: unknown) => true),
};

// Mock commands API
export const commands = {
  registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
  executeCommand: jest.fn(),
};

// Mock Uri
export const Uri = {
  file: jest.fn((path: string) => ({ fsPath: path, path, scheme: 'file' })),
  parse: jest.fn((uri: string) => ({
    fsPath: uri,
    path: uri,
    uri,
    scheme: 'file',
    toString: () => uri,
  })),
};

// Mock env API
export const env = {
  openExternal: jest.fn(),
};

// Mock ColorThemeKind enum (matches VS Code's stable values)
export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4,
}

// Mock ConfigurationTarget enum
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

// Mock TextDocument
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMockTextDocument(content: string, languageId = 'markdown'): any {
  return {
    getText: jest.fn((range?: MockRange) => {
      if (range) {
        // Simplified range extraction
        return content;
      }
      return content;
    }),
    languageId,
    uri: Uri.file('/test/document.md') as MockUri,
    fileName: '/test/document.md',
    lineCount: content.split('\n').length,
    lineAt: jest.fn((line: number) => ({
      text: content.split('\n')[line] || '',
      lineNumber: line,
    })),
  };
}

// Mock Selection
export class Selection {
  constructor(
    public anchor: { line: number; character: number },
    public active: { line: number; character: number }
  ) {}

  get isEmpty(): boolean {
    return this.anchor.line === this.active.line && this.anchor.character === this.active.character;
  }
}

// Mock TextEditor
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMockTextEditor(document: any, selection?: Selection): any {
  return {
    document,
    selection: selection || new Selection({ line: 0, character: 0 }, { line: 0, character: 0 }),
    selections: [selection || new Selection({ line: 0, character: 0 }, { line: 0, character: 0 })],
  };
}

// Reset all mocks helper
export function resetAllMocks() {
  jest.clearAllMocks();
  mockStatusBarItem.text = '';
  mockStatusBarItem.tooltip = '';
  mockStatusBarItem.command = undefined;
  window.activeTextEditor = undefined;
}

// Default export for module mock
// Minimal Position class
export class Position {
  constructor(
    public line: number,
    public character: number
  ) {}
}

// Tree item + visuals
export class TreeItem {
  public iconPath: ThemeIcon | MockUri | { light: MockUri; dark: MockUri } | undefined;
  public description?: string;
  public command?: { command: string; title: string; arguments?: unknown[] };
  public contextValue?: string;
  constructor(
    public label: string,
    public collapsibleState?: number
  ) {}
}

export class EventEmitter<T> {
  public event = jest.fn();
  fire = jest.fn((_data?: T) => {});
  dispose = jest.fn();
}

export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
};

export class ThemeIcon {
  constructor(
    public id: string,
    public color?: ThemeColor
  ) {}
}

export class ThemeColor {
  constructor(public id: string) {}
}

export default {
  window,
  workspace,
  commands,
  Uri,
  StatusBarAlignment,
  ProgressLocation,
  Selection,
  TreeItem,
  EventEmitter,
  TreeItemCollapsibleState,
  ThemeIcon,
  ThemeColor,
};

// Minimal Range class
export class Range {
  constructor(
    public start: Position,
    public end: Position
  ) {}
}

// Minimal WorkspaceEdit mock
export class WorkspaceEdit {
  public replaces: Array<{ uri: MockUri; range: Range; text: string }> = [];

  replace(uri: MockUri, range: Range, text: string) {
    this.replaces.push({ uri, range, text });
  }
}
