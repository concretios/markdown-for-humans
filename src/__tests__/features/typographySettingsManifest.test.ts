/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview The contributed reader typography settings and the code that
 * resolves them must agree, so an untouched installation changes nothing.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import { resolveTypographySettings } from '../../shared/typographySettings';
import { readResolvedManifest } from '../l10n/resolvedManifest';

interface SettingSchema {
  type: string;
  default: unknown;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  scope?: string;
  description?: string;
  markdownDescription?: string;
}

const root = path.resolve(__dirname, '../../..');
const manifest = readResolvedManifest<{
  contributes: { configuration: { properties: Record<string, SettingSchema> } };
}>();
const properties = manifest.contributes.configuration.properties;
const setting = (name: string) => properties[`markdownForHumans.font.${name}`];
const describe_ = (schema: SettingSchema) => schema.markdownDescription ?? schema.description ?? '';

describe('reader typography settings manifest', () => {
  it('contributes the six font settings with the documented types, defaults and ranges', () => {
    expect(setting('family')).toMatchObject({ type: 'string', default: '', maxLength: 1024 });
    expect(setting('weight')).toMatchObject({
      type: 'number',
      default: 400,
      minimum: 100,
      maximum: 900,
    });
    expect(setting('lineHeight')).toMatchObject({
      type: 'number',
      default: 1.58,
      minimum: 1,
      maximum: 3,
    });
    expect(setting('letterSpacing')).toMatchObject({
      type: 'number',
      default: 0,
      minimum: 0,
      maximum: 0.5,
    });
    expect(setting('wordSpacing')).toMatchObject({
      type: 'number',
      default: 0,
      minimum: 0,
      maximum: 1,
    });
    expect(setting('useEditorFont')).toMatchObject({ type: 'boolean', default: false });
  });

  it('changes nothing at the contributed defaults', () => {
    expect(
      resolveTypographySettings({
        family: setting('family').default,
        weight: setting('weight').default,
        lineHeight: setting('lineHeight').default,
        letterSpacing: setting('letterSpacing').default,
        wordSpacing: setting('wordSpacing').default,
      })
    ).toEqual({
      fontFamily: null,
      fontWeight: null,
      fontSize: null,
      lineHeight: null,
      letterSpacing: null,
      wordSpacing: null,
    });
  });

  it('keeps reading preferences personal, like zoom and paragraph spacing', () => {
    for (const name of [
      'family',
      'weight',
      'lineHeight',
      'letterSpacing',
      'wordSpacing',
      'useEditorFont',
    ]) {
      expect(setting(name).scope).toBe(properties['markdownForHumans.zoom'].scope);
    }
  });

  it('describes each setting for the reader, with one example value', () => {
    for (const name of ['family', 'weight', 'lineHeight', 'letterSpacing', 'wordSpacing']) {
      const text = describe_(setting(name));
      expect(text).toMatch(/Example: /);
      expect(text.match(/Example: /g)).toHaveLength(1);
      expect(text).not.toContain(String.fromCharCode(0x2014));
    }
    expect(describe_(setting('family'))).toMatch(/installed on your computer/);
    expect(describe_(setting('family'))).toMatch(/Code stays monospace/);
    expect(describe_(setting('useEditorFont'))).toMatch(/\[markdown\]/);
  });

  it('leaves PDF and Word export on their own print typography', () => {
    const exportSource = readFileSync(path.join(root, 'src/features/documentExport.ts'), 'utf8');
    expect(exportSource).not.toMatch(/markdownForHumans\.font|typographySettings/);
    expect(describe_(setting('family'))).toMatch(/PDF and Word exports keep their own fonts/);
  });
});
