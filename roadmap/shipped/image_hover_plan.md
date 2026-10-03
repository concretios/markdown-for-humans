## Plan: Implement User-Configurable Image Hover Overlay Toggle

> Status: shipped in 0.4.0 / Shipped: 2026-10-01

**TL;DR** - Add a new VS Code configuration setting `markdownForHumans.imagePreview.hover.enabled` (default: true) that allows users to disable the image hover overlay (shading + metadata display) to reduce visual distraction. Follow existing configuration patterns for seamless integration.

**Steps**
1. Add configuration schema to `package.json` defining the new boolean setting with default true and descriptive text.
2. Update `MarkdownEditorProvider.ts` to read the new setting and include it in `update` and `settingsUpdate` messages to the webview.
3. Modify `editor.ts` message handler to store the setting in a global window variable (`showImageHoverOverlay`).
4. Update `customImage.ts` hover event handlers to conditionally apply the `image-hover-active` class and call metadata functions only when the setting is enabled.
5. Update `imageMetadata.ts` to check the global setting before showing the metadata footer.
6. Update `imageMenu.ts` to conditionally show the menu button on hover based on the setting.
7. Add CSS rules to disable hover effects when the setting is false (e.g., prevent backdrop and metadata display).
8. Write comprehensive tests in `src/__tests__/webview/imageHover.test.ts` covering setting changes, hover behavior toggling, and UI state.
9. Update documentation: add the new setting to README.md configuration section and THIRD_PARTY_LICENSES.md if dependencies change (unlikely).
10. Perform manual verification: test in VS Code with a 3000+ word document containing images, toggling the setting and hovering.

**Relevant files**
- `package.json` — Add configuration definition
- `src/editor/MarkdownEditorProvider.ts` — Read setting and send to webview
- `src/webview/editor.ts` — Handle settingsUpdate message and store global state
- `src/webview/extensions/customImage.ts` — Modify hover event handlers to check setting
- `src/webview/features/imageMetadata.ts` — Conditionally show metadata footer
- `src/webview/features/imageMenu.ts` — Conditionally show menu button
- `src/webview/editor.css` — Add CSS rules for disabled hover state
- `src/__tests__/webview/imageHover.test.ts` — New test file for hover toggle functionality
- `README.md` — Update configuration documentation
- `THIRD_PARTY_LICENSES.md` — Check for updates (likely none)

**Verification**
1. Run `npm test` to ensure all existing and new tests pass.
2. Build extension with `npm run build:debug` and verify no TypeScript errors.
3. Install extension in VS Code development host, create test document with images.
4. Toggle setting in VS Code settings UI and confirm hover overlay appears/disappears immediately.
5. Test edge cases: setting change while hovering, multiple images, caret/selection states.
6. Read a 3000+ word document for 10+ minutes with setting on/off to verify no UX regressions.

**Decisions**
- Setting name: `markdownForHumans.imagePreview.hover.enabled` to match user's request and extension naming convention.
- Default: `true` to maintain current behavior for existing users.
- Implementation approach: Follow existing pattern (global window variable, conditional logic in features) for consistency.
- Scope: Toggle affects both shading backdrop and metadata footer/menu button display.
- No new dependencies required.

**Further Considerations**
1. Should the menu button (pencil icon) also be hidden when hover is disabled? (Recommendation: Yes, as it's part of the hover overlay experience)
2. Consider adding a command palette command to quickly toggle this setting for power users.
3. Ensure accessibility: when disabled, images should still be selectable and keyboard navigable.

---

## Technical Specification

### Configuration Schema
Add to `package.json` contributes.configuration.properties:
```json
"markdownForHumans.imagePreview.hover.enabled": {
  "type": "boolean",
  "default": true,
  "description": "Enable the image hover overlay that shades images and displays metadata (resolution, file size, etc.) on hover."
}
```

### State Management
- **Extension Layer**: Read via `vscode.workspace.getConfiguration('markdownForHumans.imagePreview.hover.enabled')`
- **Message Passing**: Include `showImageHoverOverlay: boolean` in `update` and `settingsUpdate` message payloads
- **Webview Layer**: Store as `(window as any).showImageHoverOverlay = message.showImageHoverOverlay;`
- **Feature Layer**: Check `if (!(window as any).showImageHoverOverlay) return;` before applying hover effects

### Files Requiring Modification
1. **package.json** (lines ~147-190): Add configuration property definition
2. **src/editor/MarkdownEditorProvider.ts**:
   - Lines 347-365: Add to configuration change listener
   - Lines 410-465: Include in message payloads
3. **src/webview/editor.ts** (lines 881-890): Add handler for `showImageHoverOverlay` in settingsUpdate
4. **src/webview/extensions/customImage.ts**:
   - `handleMouseEnter()`: Conditionally add `image-hover-active` class
   - `handleMouseLeave()`: Conditionally remove class and hide metadata/menu
5. **src/webview/features/imageMetadata.ts**:
   - `showImageMetadataFooter()`: Early return if setting disabled
6. **src/webview/features/imageMenu.ts**:
   - Menu button visibility logic: Hide when setting disabled
7. **src/webview/editor.css**: Add rules like `.image-wrapper:not(.image-hover-disabled) .markdown-image:hover { /* hover effects */ }` or similar conditional styling
8. **Test Files**: New `src/__tests__/webview/imageHover.test.ts` with tests for:
   - Setting propagation from extension to webview
   - Hover class application/removal based on setting
   - Metadata footer visibility toggle
   - Menu button visibility toggle
   - CSS hover effects disabled when setting false

### Integration Points
- Follows existing 3-tier config flow: Extension → Message → Webview Global → Feature Checks
- No changes to TipTap/ProseMirror architecture
- Maintains performance: setting check is lightweight global read
- Backward compatible: default true preserves current behavior</content>
<parameter name="filePath">c:\Users\sstom\Desktop\markdown-for-humans\roadmap\pipeline\image_hover_plan.md