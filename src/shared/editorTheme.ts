/**
 * Pure helpers for the editor theme override feature.
 *
 * Kept free of any `vscode` import so the toggle logic can be unit-tested in
 * isolation. The extension host passes in the raw `ColorThemeKind` numeric
 * value from `vscode.window.activeColorTheme.kind`.
 */

/** The value of the `markdownForHumans.display.editorTheme` setting. */
export type EditorThemeSetting = 'vscode' | 'defaultLight' | 'defaultDark';

/** A forced theme the toolbar toggle can write back to the setting. */
export type ForcedTheme = 'defaultLight' | 'defaultDark';

/** The light/dark appearance the editor actually renders. */
export type Appearance = 'light' | 'dark';

/**
 * VS Code `ColorThemeKind` numeric values (stable enum):
 * Light = 1, Dark = 2, HighContrast = 3 (a dark variant), HighContrastLight = 4.
 * High-contrast dark counts as dark; high-contrast light counts as light.
 */
export function appearanceFromKind(kind: number): Appearance {
  return kind === 2 || kind === 3 ? 'dark' : 'light';
}

/**
 * Resolves what the editor currently shows: the forced value when the setting
 * pins light/dark, otherwise whatever VS Code's active theme implies.
 */
export function effectiveAppearance(setting: EditorThemeSetting, vscodeKind: number): Appearance {
  if (setting === 'defaultLight') return 'light';
  if (setting === 'defaultDark') return 'dark';
  return appearanceFromKind(vscodeKind);
}

/**
 * The toolbar toggle writes the opposite of the currently effective appearance,
 * so a single click always flips the visible theme.
 */
export function resolveToggleTarget(setting: EditorThemeSetting, vscodeKind: number): ForcedTheme {
  return effectiveAppearance(setting, vscodeKind) === 'dark' ? 'defaultLight' : 'defaultDark';
}

/**
 * The override class the webview applies, or `null` to inherit VS Code's live
 * theme (no override).
 *
 * Key behavior: when the requested direction already matches VS Code's active
 * appearance, we return `null` so the editor inherits the real theme (best
 * fidelity - matches whatever dark/light theme the user actually uses). The
 * synthetic palette is applied only when forcing the *opposite* of the active
 * appearance, where there is no live theme to inherit.
 */
export function overrideClassFor(
  setting: EditorThemeSetting,
  vscodeIsDark: boolean
): string | null {
  if (setting === 'vscode') return null;
  const wantDark = setting === 'defaultDark';
  if (wantDark === vscodeIsDark) return null; // active theme already matches -> inherit it
  return wantDark ? 'mdfh-force-dark' : 'mdfh-force-light';
}
