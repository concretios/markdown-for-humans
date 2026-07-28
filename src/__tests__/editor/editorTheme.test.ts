import {
  appearanceFromKind,
  effectiveAppearance,
  overrideClassFor,
  resolveToggleTarget,
} from '../../shared/editorTheme';

// VS Code ColorThemeKind numeric values (stable API enum):
// Light = 1, Dark = 2, HighContrast = 3 (dark), HighContrastLight = 4
const LIGHT = 1;
const DARK = 2;
const HIGH_CONTRAST = 3;
const HIGH_CONTRAST_LIGHT = 4;

describe('appearanceFromKind', () => {
  it('maps the Light kind to light', () => {
    expect(appearanceFromKind(LIGHT)).toBe('light');
  });

  it('maps the Dark kind to dark', () => {
    expect(appearanceFromKind(DARK)).toBe('dark');
  });

  it('maps the HighContrast (dark) kind to dark', () => {
    expect(appearanceFromKind(HIGH_CONTRAST)).toBe('dark');
  });

  it('maps the HighContrastLight kind to light', () => {
    expect(appearanceFromKind(HIGH_CONTRAST_LIGHT)).toBe('light');
  });
});

describe('effectiveAppearance', () => {
  it('follows VS Code when the setting is "vscode"', () => {
    expect(effectiveAppearance('vscode', DARK)).toBe('dark');
    expect(effectiveAppearance('vscode', LIGHT)).toBe('light');
  });

  it('forces light regardless of VS Code when the setting is "defaultLight"', () => {
    expect(effectiveAppearance('defaultLight', DARK)).toBe('light');
  });

  it('forces dark regardless of VS Code when the setting is "defaultDark"', () => {
    expect(effectiveAppearance('defaultDark', LIGHT)).toBe('dark');
  });
});

describe('resolveToggleTarget', () => {
  it('writes light when the editor currently shows dark via VS Code', () => {
    expect(resolveToggleTarget('vscode', DARK)).toBe('defaultLight');
  });

  it('writes dark when the editor currently shows light via VS Code', () => {
    expect(resolveToggleTarget('vscode', LIGHT)).toBe('defaultDark');
  });

  it('writes light when the setting already forces dark', () => {
    expect(resolveToggleTarget('defaultDark', LIGHT)).toBe('defaultLight');
  });

  it('writes dark when the setting already forces light', () => {
    expect(resolveToggleTarget('defaultLight', DARK)).toBe('defaultDark');
  });

  it('treats HighContrast (dark) as dark and writes light', () => {
    expect(resolveToggleTarget('vscode', HIGH_CONTRAST)).toBe('defaultLight');
  });
});

describe('overrideClassFor', () => {
  it('applies no override class when following VS Code', () => {
    expect(overrideClassFor('vscode', true)).toBeNull();
    expect(overrideClassFor('vscode', false)).toBeNull();
  });

  it('inherits the live theme when forcing dark and VS Code is already dark', () => {
    expect(overrideClassFor('defaultDark', true)).toBeNull();
  });

  it('inherits the live theme when forcing light and VS Code is already light', () => {
    expect(overrideClassFor('defaultLight', false)).toBeNull();
  });

  it('applies the synthetic dark palette when forcing dark over a light VS Code', () => {
    expect(overrideClassFor('defaultDark', false)).toBe('mdfh-force-dark');
  });

  it('applies the synthetic light palette when forcing light over a dark VS Code', () => {
    expect(overrideClassFor('defaultLight', true)).toBe('mdfh-force-light');
  });
});
