/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/** Schema version for the deliberately small VS Code webview state payload. */
export const RICH_VIEW_STATE_VERSION = 1 as const;

/** Defensive coordinate ceilings keep corrupted webview state cheap to parse and apply. */
export const MAX_RICH_VIEW_POSITION = 50_000_000;
export const MAX_RICH_VIEW_SCROLL_TOP = 100_000_000;

export type RichViewSelectionState = Readonly<{
  from: number;
  to: number;
}>;

/**
 * Ephemeral presentation state that VS Code may retain while a hidden webview
 * is torn down. Document text and feature-controller state intentionally do
 * not belong in this payload.
 */
export type RichViewState = Readonly<{
  version: typeof RICH_VIEW_STATE_VERSION;
  documentVersion: number;
  selection: RichViewSelectionState;
  scrollTop: number;
}>;

export type CurrentRichViewState = Readonly<{
  documentVersion: number;
  selection: RichViewSelectionState;
  scrollTop: number;
}>;

type RichViewStateControllerOptions = Readonly<{
  initialState: unknown;
  readCurrentState: () => CurrentRichViewState | null;
  writeState: (state: RichViewState) => void;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (frameId: number) => void;
  onError?: (error: unknown) => void;
}>;

type RestoreOptions = Readonly<{
  documentVersion: number;
  maximumPosition: number;
  applySelection: (selection: RichViewSelectionState) => boolean;
  applyScroll: (scrollTop: number) => void;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function isBoundedScrollTop(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_RICH_VIEW_SCROLL_TOP
  );
}

/**
 * Parse persisted state by projection, never by spreading the input. This is
 * the boundary that prevents stale document content, Feedback sessions, locks,
 * or future unrelated UI fields from becoming restoration authority.
 */
export function parseRichViewState(value: unknown): RichViewState | null {
  if (!isRecord(value) || value.version !== RICH_VIEW_STATE_VERSION) return null;
  if (!isBoundedInteger(value.documentVersion, Number.MAX_SAFE_INTEGER)) return null;
  if (!isRecord(value.selection)) return null;
  if (!isBoundedInteger(value.selection.from, MAX_RICH_VIEW_POSITION)) return null;
  if (!isBoundedInteger(value.selection.to, MAX_RICH_VIEW_POSITION)) return null;
  if (value.selection.from > value.selection.to) return null;
  if (!isBoundedScrollTop(value.scrollTop)) return null;

  return {
    version: RICH_VIEW_STATE_VERSION,
    documentVersion: value.documentVersion,
    selection: {
      from: value.selection.from,
      to: value.selection.to,
    },
    scrollTop: value.scrollTop,
  };
}

function createRichViewState(value: CurrentRichViewState): RichViewState | null {
  if (!isBoundedInteger(value.documentVersion, Number.MAX_SAFE_INTEGER)) return null;
  if (!Number.isFinite(value.selection.from) || !Number.isFinite(value.selection.to)) return null;
  if (!Number.isFinite(value.scrollTop)) return null;

  const first = Math.max(0, Math.min(MAX_RICH_VIEW_POSITION, Math.trunc(value.selection.from)));
  const second = Math.max(0, Math.min(MAX_RICH_VIEW_POSITION, Math.trunc(value.selection.to)));

  return {
    version: RICH_VIEW_STATE_VERSION,
    documentVersion: value.documentVersion,
    selection: {
      from: Math.min(first, second),
      to: Math.max(first, second),
    },
    scrollTop: Math.max(0, Math.min(MAX_RICH_VIEW_SCROLL_TOP, value.scrollTop)),
  };
}

/**
 * Coalesces hot selection/scroll events and owns the one delayed scroll
 * correction needed after TipTap lays out a recreated document.
 */
export class RichViewStateController {
  private readonly restoredState: RichViewState | null;
  private persistFrame: number | null = null;
  private restoreFrame: number | null = null;
  private disposed = false;

  constructor(private readonly options: RichViewStateControllerOptions) {
    this.restoredState = parseRichViewState(options.initialState);
  }

  /**
   * Restore against the saved host version or its immediate successor. Hiding
   * flushes at most one coalesced webview edit before teardown, and that edit
   * advances VS Code's TextDocument version once.
   */
  public restore(options: RestoreOptions): boolean {
    if (this.disposed) return false;
    const state = this.restoredState;
    const versionMatches =
      state !== null &&
      (state.documentVersion === options.documentVersion ||
        (state.documentVersion < Number.MAX_SAFE_INTEGER &&
          state.documentVersion + 1 === options.documentVersion));
    if (!state || !versionMatches) return false;
    if (!isBoundedInteger(options.maximumPosition, MAX_RICH_VIEW_POSITION)) return false;

    const selection = {
      from: Math.min(state.selection.from, options.maximumPosition),
      to: Math.min(state.selection.to, options.maximumPosition),
    };

    try {
      options.applySelection(selection);
      options.applyScroll(state.scrollTop);
    } catch (error) {
      this.options.onError?.(error);
    }

    this.cancelPendingRestore();
    this.restoreFrame = this.options.requestFrame(() => {
      this.restoreFrame = null;
      if (this.disposed) return;
      try {
        options.applyScroll(state.scrollTop);
      } catch (error) {
        this.options.onError?.(error);
      }
    });
    return true;
  }

  /** Prevent presentation recovery from racing a host-owned feature restoration. */
  public cancelPendingRestore(): void {
    if (this.restoreFrame === null) return;
    this.options.cancelFrame(this.restoreFrame);
    this.restoreFrame = null;
  }

  /** Persist at most once per animation frame during cursor movement or scrolling. */
  public schedulePersist(): void {
    if (this.disposed || this.persistFrame !== null) return;
    this.persistFrame = this.options.requestFrame(() => {
      this.persistFrame = null;
      this.persistCurrentState();
    });
  }

  /** Capture the final UI coordinates before the webview document is discarded. */
  public flushPersist(): boolean {
    if (this.disposed) return false;
    if (this.persistFrame !== null) {
      this.options.cancelFrame(this.persistFrame);
      this.persistFrame = null;
    }
    return this.persistCurrentState();
  }

  public dispose(): void {
    if (this.disposed) return;
    if (this.persistFrame !== null) this.options.cancelFrame(this.persistFrame);
    this.cancelPendingRestore();
    this.persistFrame = null;
    this.disposed = true;
  }

  private persistCurrentState(): boolean {
    try {
      const current = this.options.readCurrentState();
      if (!current) return false;
      const state = createRichViewState(current);
      if (!state) return false;
      this.options.writeState(state);
      return true;
    } catch (error) {
      this.options.onError?.(error);
      return false;
    }
  }
}
