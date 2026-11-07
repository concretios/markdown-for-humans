/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Finds English UI text that is written straight into a UI sink instead of
 * going through `vscode.l10n.t`, `l10n.t` or `l10n.html`.
 *
 * It looks only at places that certainly show text to a user: VS Code
 * notification and picker calls, DOM text and label properties, labelled
 * attributes, and this codebase's own UI helpers. Text that reaches the UI
 * through a variable is not seen, so a clean result is necessary, not sufficient.
 *
 * Put `l10n-ignore: <reason>` in a comment on the same or the previous line for
 * text that must stay as written (a product name, a key name, a file format).
 */

import * as ts from 'typescript';
import { isL10nCall, type SourceText } from './extraction';

/** Files whose prose is a file format or a diagnostic, never UI to translate. */
export const UNTRANSLATED_FILES: ReadonlySet<string> = new Set([
  // Sealed Feedback bundle, agent handoff prompt and their validators.
  'src/editor/feedbackReportV2.ts',
  'src/editor/feedbackHandoffPrompt.ts',
  'src/editor/feedbackItemSummaryV2.ts',
  'src/editor/feedbackMigrationV2.ts',
  'src/editor/feedbackTargetEvidenceV2.ts',
  'src/editor/feedbackSourceEvidence.ts',
  'src/editor/feedbackSessionStore.ts',
  'src/editor/feedbackAnchors.ts',
  'src/editor/feedbackSnapshotService.ts',
  'src/editor/feedbackLifecycleMachine.ts',
  'src/shared/feedbackEvidenceV2.ts',
]);

const TEXT_PROPERTIES = new Set([
  'textContent',
  'innerText',
  'innerHTML',
  'title',
  'placeholder',
  'ariaLabel',
  'alt',
  'tooltip',
]);
const LABEL_KEYS = new Set([
  'label',
  'title',
  'tooltip',
  'placeholder',
  'placeHolder',
  'description',
  'ariaLabel',
  'message',
  'detail',
  'prompt',
  'openLabel',
  'saveLabel',
  'confirmLabel',
  'heading',
]);
const LABEL_ATTRIBUTES = new Set([
  'aria-label',
  'title',
  'placeholder',
  'alt',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'data-tooltip',
  'data-placeholder',
]);
const HOST_UI_CALL =
  /(show(Information|Warning|Error)Message|showQuickPick|showInputBox|showSaveDialog|showOpenDialog|withProgress|setStatusBarMessage)$/;
const WEBVIEW_UI_CALL =
  /(^|\.)(announce|showToast|showCaptureError|reportError|showError|createButton|makeActionButton|createPreviewCard|renderSyncRetryAlert|showSurfaceAttention|alert)$/;

export interface HardcodedText {
  file: string;
  line: number;
  text: string;
}

function templateText(node: ts.TemplateExpression): string {
  return (
    node.head.text + node.templateSpans.map((span, i) => `{${i}}${span.literal.text}`).join('')
  );
}

/** Visible text nodes and labelled attributes of an HTML fragment. */
export function htmlTextSegments(markup: string): string[] {
  const segments: string[] = [];
  const attribute = /\b(?:title|aria-label|placeholder|alt)="([^"]*[A-Za-z]{2,}[^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attribute.exec(markup))) segments.push(match[1]);
  for (const part of markup
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .split(/<[^>]+>/)) {
    const text = part
      .replace(/\{\d+\}/g, ' ')
      .replace(/&[a-z]+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (/[A-Za-z]{2,}/.test(text)) segments.push(text);
  }
  return segments;
}

/** True when the text reads as words for a person, not as an identifier or a selector. */
export function looksLikeProse(raw: string): boolean {
  if (/<[a-z][^>]*>/i.test(raw)) return htmlTextSegments(raw).length > 0;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length < 2 || !/[A-Za-z]{2,}/.test(text)) return false;
  if (/^[.#[@:*>~+-]/.test(text) && !/^[-•] /.test(text)) return false;
  if (/^(https?:|vscode|data:|file:|\/|\.\/|\.\.\/|calc\(|min\(|max\(|rgba?\(|\$\()/.test(text)) {
    return /^\$\([a-z-]+\) .*[A-Za-z]{2,}/.test(text);
  }
  if (/^[a-z][A-Za-z0-9]*([.:_/-][A-Za-z0-9]+)*$/.test(text)) return false;
  if (/^[A-Z0-9_]+$/.test(text) || /^[A-Z][A-Za-z]+Error$/.test(text)) return false;
  const tokens = text.split(' ');
  // A class list: lowercase tokens, at least one of them hyphenated.
  if (tokens.every(token => /^[a-z0-9{}]+(-[a-z0-9{}]+)*$/.test(token)) && text.includes('-')) {
    return false;
  }
  const words = tokens.filter(word => /[A-Za-z]{2,}/.test(word));
  if (words.length >= 2) return true;
  return (
    /^[A-Z][a-z]+[.!?:…]*$/.test(text) || /\{\d+\}/.test(text) || /^[A-Z][a-z]+ ?\(.*\)$/.test(text)
  );
}

function isUiSink(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  let child: ts.Node = node;
  for (let parent = node.parent, depth = 0; parent && depth < 12; depth++) {
    if (isL10nCall(parent, sourceFile)) return false;
    if (ts.isCaseClause(parent)) return false;
    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        operator === ts.SyntaxKind.EqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsToken
      ) {
        return false;
      }
      if (operator === ts.SyntaxKind.EqualsToken && parent.right === child) {
        return (
          ts.isPropertyAccessExpression(parent.left) && TEXT_PROPERTIES.has(parent.left.name.text)
        );
      }
    }
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      const callee = parent.expression.getText(sourceFile).replace(/\s+/g, '');
      if (/^console\./.test(callee) || (ts.isNewExpression(parent) && /Error$/.test(callee))) {
        return false;
      }
      if (/setAttribute$/.test(callee)) {
        const [name, value] = parent.arguments ?? [];
        return value === child && ts.isStringLiteral(name) && LABEL_ATTRIBUTES.has(name.text);
      }
      if (HOST_UI_CALL.test(callee) || WEBVIEW_UI_CALL.test(callee)) return true;
    }
    if (ts.isPropertyAssignment(parent)) {
      if (parent.name === child) return false;
      if (parent.initializer === child && LABEL_KEYS.has(parent.name.getText(sourceFile))) {
        // `{ message, comment }` handed to a translation call is already translated.
        return !isL10nCall(parent.parent.parent, sourceFile);
      }
    }
    if (ts.isFunctionLike(parent) || ts.isSourceFile(parent)) return false;
    child = parent;
    parent = parent.parent;
  }
  return false;
}

export function findHardcodedText(files: SourceText[]): HardcodedText[] {
  const found: HardcodedText[] = [];
  for (const { name, text } of files) {
    if (UNTRANSLATED_FILES.has(name)) continue;
    const sourceFile = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    const lines = text.split('\n');
    const visit = (node: ts.Node): void => {
      const isLiteral =
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node);
      if (isLiteral) {
        const literal = ts.isTemplateExpression(node) ? templateText(node) : node.text;
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const ignored = /l10n-ignore/.test(`${lines[line - 1] ?? ''}\n${lines[line]}`);
        if (!ignored && looksLikeProse(literal) && isUiSink(node, sourceFile)) {
          found.push({ file: name, line: line + 1, text: literal.replace(/\s+/g, ' ').trim() });
        }
        if (!ts.isTemplateExpression(node)) return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return found;
}
