/**
 * Copyright (c) 2025-2026 Concret.io
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import type { Decoration } from '@tiptap/pm/view';
import * as l10n from '../l10n';
import type { FrontmatterPresentation } from './presentation';
import { REVEAL_FRONTMATTER } from './plugin';
import { renderFrontmatterProperties } from './properties';

/**
 * Mount a reading view alongside the existing editable YAML and switch between them locally.
 * @param focusYaml - Puts the caret in the YAML for editing.
 * @param focusBody - Puts the caret in the first text after the frontmatter; false when there is none.
 */
export function createFrontmatterControls(
  wrapper: HTMLElement,
  focusYaml: () => void,
  focusBody: () => boolean
) {
  const dom = document.createElement('section');
  dom.className = 'md4h-frontmatter-properties';
  dom.contentEditable = 'false';
  dom.setAttribute('aria-label', l10n.t('Frontmatter'));
  dom.hidden = true;

  const header = document.createElement('div');
  header.className = 'md4h-frontmatter-header';
  const heading = document.createElement('strong');
  heading.textContent = l10n.t('Frontmatter');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = l10n.t('Edit YAML');
  header.append(heading, toggle);
  dom.append(header);
  wrapper.prepend(dom);

  let editing = false;
  let propertiesMode = false;
  let lastPresentation: FrontmatterPresentation | undefined;
  let fields: HTMLElement | undefined;
  const syncView = (): void => {
    dom.hidden = !propertiesMode || (!lastPresentation && !editing);
    toggle.disabled = !lastPresentation;
    wrapper.toggleAttribute('data-frontmatter-editing', editing);
    toggle.textContent = editing ? l10n.t('Show properties') : l10n.t('Edit YAML');
    if (fields) fields.hidden = editing;
  };
  wrapper.addEventListener(REVEAL_FRONTMATTER, () => {
    editing = true;
    syncView();
  });
  toggle.addEventListener('click', event => {
    event.stopPropagation();
    editing = !editing;
    syncView();
    if (editing) focusYaml();
    // A mouse click returns to the text so Cmd+Z and typing work at once. Keyboard
    // activation (detail 0) keeps focus on the toggle so it can be pressed again.
    else if (event.detail === 0 || !focusBody()) toggle.focus({ preventScroll: true });
  });

  return {
    dom,
    update: (decorations: readonly Decoration[]): void => {
      const decoration = decorations.find(item => item.spec.style === 'properties');
      propertiesMode = Boolean(decoration);
      if (!propertiesMode) editing = false;
      const next = decoration?.spec.frontmatter as FrontmatterPresentation | undefined;
      if (lastPresentation !== next) {
        lastPresentation = next;
        fields?.remove();
        fields = next ? renderFrontmatterProperties(next.properties) : undefined;
        if (fields) dom.append(fields);
      }
      syncView();
    },
  };
}
