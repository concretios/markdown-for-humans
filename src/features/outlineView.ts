/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import * as vscode from 'vscode';

export interface OutlineEntry {
  level: number;
  text: string;
  pos: number;
  sectionEnd: number;
}

export interface OutlineNode extends OutlineEntry {
  children: OutlineNode[];
}

type AncestorState = 'active' | 'ancestor' | 'none';

class OutlineTreeItem extends vscode.TreeItem {
  constructor(
    readonly node: OutlineNode,
    readonly ancestorState: AncestorState,
    collapsible?: vscode.TreeItemCollapsibleState
  ) {
    // Use TreeItemLabel for bold effect on active/ancestor items
    const labelText = node.text || vscode.l10n.t('(Untitled)');
    super(
      ancestorState !== 'none'
        ? { label: labelText, highlights: [[0, labelText.length]] }
        : labelText,
      collapsible ??
        (node.children.length
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None)
    );
    this.description = vscode.l10n.t('H{0}', node.level);
    this.command = {
      command: 'markdownForHumans.navigateToHeading',
      title: vscode.l10n.t('Go to heading'),
      arguments: [node.pos],
    };
    if (ancestorState === 'active') {
      this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    } else if (ancestorState === 'ancestor') {
      this.iconPath = new vscode.ThemeIcon('chevron-right', new vscode.ThemeColor('charts.green'));
    }
    this.contextValue =
      ancestorState === 'active'
        ? 'outlineActive'
        : ancestorState === 'ancestor'
          ? 'outlineAncestor'
          : 'outlineItem';
  }
}

export class OutlineViewProvider implements vscode.TreeDataProvider<OutlineTreeItem> {
  private outline: OutlineEntry[] = [];
  private tree: OutlineNode[] = [];
  private filteredTree: OutlineNode[] = [];
  private activePos: number | null = null;
  private activeNode: OutlineNode | null = null; // Cached active node to avoid redundant traversals
  private filterText = '';
  private treeView?: vscode.TreeView<OutlineTreeItem>;
  private itemMap = new WeakMap<OutlineNode, OutlineTreeItem>();
  private parentMap = new Map<OutlineNode, OutlineNode | null>();
  private pendingReveal = false;
  private activeAncestorPath = new Set<OutlineNode>();
  private filterQuickPick?: vscode.QuickPick<vscode.QuickPickItem>;
  private _onDidChangeTreeData = new vscode.EventEmitter<OutlineTreeItem | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  setTreeView(view: vscode.TreeView<OutlineTreeItem>) {
    this.treeView = view;
  }

  setOutline(outline: OutlineEntry[]) {
    this.outline = outline || [];
    this.tree = this.buildTree(this.outline);
    this.filteredTree = this.applyFilter(this.tree, this.filterText);
    this.itemMap = new WeakMap();
    this.activeAncestorPath.clear();
    // Recalculate ancestor path with new tree
    if (this.activePos !== null) {
      this.updateActiveAncestorPath();
    }
    this.refresh();
  }

  setActiveSelection(pos: number | null) {
    this.activePos = pos;
    this.updateActiveAncestorPath();
    this.pendingReveal = true;
    this.refresh();
  }

  setFilter(text: string) {
    this.filterText = text || '';
    this.filteredTree = this.applyFilter(this.tree, this.filterText);
    this.itemMap = new WeakMap();
    this.updateFilterContext();
    this.refresh();
  }

  clearFilter() {
    this.filterText = '';
    this.filteredTree = this.tree;
    this.itemMap = new WeakMap();
    this.updateFilterContext();
    this.refresh();
    // Close quick pick if open
    if (this.filterQuickPick) {
      this.filterQuickPick.hide();
    }
  }

  hasActiveFilter(): boolean {
    return this.filterText.length > 0;
  }

  private updateFilterContext() {
    vscode.commands.executeCommand(
      'setContext',
      'markdownForHumans.outlineFilterActive',
      this.filterText.length > 0
    );
  }

  showFilterInput() {
    // Close existing QuickPick if already open
    if (this.filterQuickPick) {
      this.filterQuickPick.hide();
    }

    // Use QuickPick for live filtering
    this.filterQuickPick = vscode.window.createQuickPick();
    this.filterQuickPick.placeholder = vscode.l10n.t(
      'Type to filter headings... (X to clear, Esc to close)'
    );
    this.filterQuickPick.value = this.filterText;

    this.filterQuickPick.onDidChangeValue(value => {
      this.setFilter(value);
    });

    this.filterQuickPick.onDidHide(() => {
      this.filterQuickPick?.dispose();
      this.filterQuickPick = undefined;
    });

    this.filterQuickPick.onDidAccept(() => {
      // Keep filter, just close the input
      this.filterQuickPick?.hide();
    });

    this.filterQuickPick.show();
  }

  revealActive(view?: vscode.TreeView<OutlineTreeItem>) {
    const targetView = view || this.treeView;
    if (!targetView || !this.activeNode) return;

    // Get or create item for reveal
    let item = this.itemMap.get(this.activeNode);
    if (!item) {
      // Create item if needed (supports auto-expand in collapsed mode)
      item = new OutlineTreeItem(
        this.activeNode,
        'active',
        this.getCollapsibleState(this.activeNode)
      );
      this.itemMap.set(this.activeNode, item);
    }

    targetView.reveal(item, { expand: true, focus: true, select: true });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: OutlineTreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  getChildren(element?: OutlineTreeItem): vscode.ProviderResult<OutlineTreeItem[]> {
    const sourceTree = this.filteredTree.length ? this.filteredTree : this.tree;

    if (!sourceTree.length) {
      return [];
    }

    const nodes = element ? element.node.children : sourceTree;
    const items = nodes.map(node => {
      const ancestorState = this.getAncestorState(node);
      const existingItem = this.itemMap.get(node);

      // Reuse existing item if state matches (important for reveal() to work)
      // Create fresh item only if state changed or item doesn't exist
      const expectedContextValue =
        ancestorState === 'active'
          ? 'outlineActive'
          : ancestorState === 'ancestor'
            ? 'outlineAncestor'
            : 'outlineItem';

      if (existingItem && existingItem.contextValue === expectedContextValue) {
        // Update collapsible state in case it changed
        existingItem.collapsibleState = this.getCollapsibleState(node);
        return existingItem;
      }

      // Create fresh TreeItem for new items or state changes
      const item = new OutlineTreeItem(node, ancestorState, this.getCollapsibleState(node));
      this.itemMap.set(node, item);
      return item;
    });

    // After root items are created, do pending reveal
    if (!element && this.pendingReveal) {
      this.pendingReveal = false;
      // Defer to let tree render first
      setTimeout(() => this.doRevealActive(), 50);
    }

    return items;
  }

  private isEntryActive(entry: OutlineEntry): boolean {
    if (this.activePos === null || this.activePos === undefined) return false;
    return this.activePos >= entry.pos && this.activePos < entry.sectionEnd;
  }

  private getAncestorState(node: OutlineNode): AncestorState {
    // Use cached active node instead of redundant traversal
    if (node === this.activeNode) {
      return 'active';
    }
    if (this.activeAncestorPath.has(node)) {
      return 'ancestor';
    }
    return 'none';
  }

  private updateActiveAncestorPath() {
    this.activeAncestorPath.clear();
    this.activeNode = null;

    if (this.activePos === null) return;

    const sourceTree = this.filteredTree.length ? this.filteredTree : this.tree;
    this.findAndCacheActiveNode(sourceTree, []);
  }

  /**
   * Single-pass traversal that finds the deepest active node and builds ancestor path
   * This replaces the previous hasActiveChild + buildAncestorPath approach for better performance
   */
  private findAndCacheActiveNode(nodes: OutlineNode[], ancestors: OutlineNode[]): boolean {
    for (const node of nodes) {
      if (this.isEntryActive(node)) {
        // Check if this node has an active child
        if (
          node.children.length === 0 ||
          !this.findAndCacheActiveNode(node.children, [...ancestors, node])
        ) {
          // This is the deepest active node (no active children)
          this.activeNode = node;
          ancestors.forEach(ancestor => this.activeAncestorPath.add(ancestor));
          return true;
        }
        // Active child was found, this node is an ancestor
        return true;
      }
    }
    return false;
  }

  private buildTree(entries: OutlineEntry[]): OutlineNode[] {
    const roots: OutlineNode[] = [];
    const stack: OutlineNode[] = [];
    this.parentMap.clear();

    entries.forEach(entry => {
      const node: OutlineNode = { ...entry, children: [] };

      while (stack.length && stack[stack.length - 1].level >= node.level) {
        stack.pop();
      }

      const parent = stack[stack.length - 1];
      if (parent) {
        parent.children.push(node);
        this.parentMap.set(node, parent);
      } else {
        roots.push(node);
        this.parentMap.set(node, null);
      }

      stack.push(node);
    });

    return roots;
  }

  // Required for TreeView.reveal() to work with nested items
  getParent(element: OutlineTreeItem): vscode.ProviderResult<OutlineTreeItem> {
    const parentNode = this.parentMap.get(element.node);
    if (!parentNode) return null;

    // Create parent item if it doesn't exist yet (parent might be collapsed)
    let item = this.itemMap.get(parentNode);
    if (!item) {
      item = new OutlineTreeItem(
        parentNode,
        this.getAncestorState(parentNode),
        this.getCollapsibleState(parentNode)
      );
      this.itemMap.set(parentNode, item);
    }
    return item;
  }

  private applyFilter(nodes: OutlineNode[], term: string): OutlineNode[] {
    if (!term.trim()) return nodes;

    // Clear parentMap to prevent memory leak from stale references
    this.parentMap.clear();

    const lowered = term.toLowerCase();

    // First pass: filter and create new nodes
    const filterRecursive = (list: OutlineNode[]): OutlineNode[] => {
      const result: OutlineNode[] = [];
      list.forEach(node => {
        const children = filterRecursive(node.children);
        if (node.text.toLowerCase().includes(lowered) || children.length) {
          result.push({ ...node, children });
        }
      });
      return result;
    };

    const filtered = filterRecursive(nodes);

    // Second pass: update parentMap for filtered nodes
    const updateParents = (list: OutlineNode[], parent: OutlineNode | null) => {
      list.forEach(node => {
        this.parentMap.set(node, parent);
        updateParents(node.children, node);
      });
    };
    updateParents(filtered, null);

    return filtered;
  }

  private getCollapsibleState(node: OutlineNode): vscode.TreeItemCollapsibleState {
    if (!node.children.length) return vscode.TreeItemCollapsibleState.None;

    // Always expand active nodes and their ancestors to show current position
    if (this.isEntryActive(node) || this.activeAncestorPath.has(node)) {
      return vscode.TreeItemCollapsibleState.Expanded;
    }

    // Default: expanded (tree starts fully expanded)
    return vscode.TreeItemCollapsibleState.Expanded;
  }

  private doRevealActive() {
    const targetView = this.treeView;
    if (!targetView || !this.activeNode) return;

    // Ensure item exists in map
    let item = this.itemMap.get(this.activeNode);
    if (!item) {
      item = new OutlineTreeItem(
        this.activeNode,
        'active',
        this.getCollapsibleState(this.activeNode)
      );
      this.itemMap.set(this.activeNode, item);
    }

    targetView.reveal(item, { expand: true, focus: false, select: true });
  }
}

export const outlineViewProvider = new OutlineViewProvider();
