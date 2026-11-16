/**
 * Copyright (c) 2025-2026 Concret.io
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import type { FrontmatterField, FrontmatterValue } from './presentation';

/** Render a bounded YAML reading view. All authored fields and values are text. */
export function renderFrontmatterProperties(fields: FrontmatterField[]): HTMLElement {
  const list = document.createElement('dl');
  list.className = 'md4h-frontmatter-fields';
  for (const field of fields) {
    const row = document.createElement('div');
    if (field.key === 'title') row.className = 'md4h-frontmatter-title';
    if (field.key === 'summary') row.className = 'md4h-frontmatter-summary';
    const label = document.createElement('dt');
    label.textContent = field.key;
    const value = document.createElement('dd');
    value.append(renderValue(field.value));
    row.append(label, value);
    list.append(row);
  }
  return list;
}

function renderValue(value: FrontmatterValue): HTMLElement {
  if (value.kind === 'map') {
    if (value.fields.length) return renderFrontmatterProperties(value.fields);
    const empty = document.createElement('span');
    empty.textContent = '{}';
    return empty;
  }
  if (value.kind === 'list') {
    if (value.items.length === 0) {
      const empty = document.createElement('span');
      empty.textContent = '[]';
      return empty;
    }
    const list = document.createElement('ul');
    if (value.flow && value.items.every(item => item.kind === 'scalar')) {
      list.className = 'md4h-frontmatter-chips';
    }
    for (const item of value.items) {
      const entry = document.createElement('li');
      if (list.className) entry.className = 'md4h-frontmatter-chip';
      entry.append(renderValue(item));
      list.append(entry);
    }
    return list;
  }
  const text = document.createElement('span');
  text.dataset.frontmatterTone = value.tone;
  text.textContent = value.text;
  return text;
}
