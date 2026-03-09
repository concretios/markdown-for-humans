/**
 * Returns true when the keyboard event represents Cmd/Ctrl+S.
 */
export function isSaveShortcut(event: KeyboardEvent): boolean {
  const isMod = event.metaKey || event.ctrlKey;
  return isMod && event.key.toLowerCase() === 's';
}
