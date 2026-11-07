/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Finds every message passed to `vscode.l10n.t`, `l10n.t` or `l10n.html` in the
 * source tree. Shared by the bundle guard and by `npm run l10n:extract`.
 */

import { readFileSync, readdirSync } from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export const repoRoot = path.resolve(__dirname, '../../..');
export const sourceRoot = path.join(repoRoot, 'src');
export const bundleRoot = path.join(repoRoot, 'l10n');

/** One extracted message; `comment` is present for the options form. */
export interface ExtractedMessage {
  message: string;
  comment?: string[];
}

export interface Extraction {
  /** Bundle key (`message` or `message/comment`) to its source. */
  messages: Map<string, ExtractedMessage>;
  /** `file:line` of calls whose message cannot be read statically. */
  unextractable: string[];
}

export interface SourceText {
  name: string;
  text: string;
}

/** Every shipped TypeScript source file; tests and mocks are excluded. */
export function readSourceFiles(dir: string = sourceRoot, found: SourceText[] = []): SourceText[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== '__mocks__')
        readSourceFiles(fullPath, found);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push({
        name: path.relative(repoRoot, fullPath).split(path.sep).join('/'),
        text: readFileSync(fullPath, 'utf8'),
      });
    }
  }
  return found;
}

/** True for a call to one of the translation functions. */
export function isL10nCall(node: ts.Node, sourceFile: ts.SourceFile): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) && /(^|\.)l10n\.(t|html)$/.test(node.expression.getText(sourceFile))
  );
}

function literalText(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const member of object.properties) {
    if (ts.isPropertyAssignment(member) && member.name.getText() === name)
      return member.initializer;
  }
  return undefined;
}

/**
 * Read the message argument of a translation call.
 *
 * Accepts a string literal, a `condition ? 'one' : 'other'` choice between
 * literals (for singular and plural forms), or the `{ message, comment }` form.
 */
function readMessages(argument: ts.Expression | undefined): ExtractedMessage[] | undefined {
  if (!argument) return undefined;
  const text = literalText(argument);
  if (text !== undefined) return [{ message: text }];
  if (ts.isParenthesizedExpression(argument)) return readMessages(argument.expression);
  if (ts.isConditionalExpression(argument)) {
    const whenTrue = readMessages(argument.whenTrue);
    const whenFalse = readMessages(argument.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : undefined;
  }
  if (ts.isObjectLiteralExpression(argument)) {
    const message = literalText(property(argument, 'message'));
    const commentNode = property(argument, 'comment');
    const comment = commentNode
      ? ts.isArrayLiteralExpression(commentNode)
        ? commentNode.elements.map(literalText)
        : [literalText(commentNode)]
      : undefined;
    if (message === undefined || !comment || comment.some(part => part === undefined)) {
      return undefined;
    }
    return [{ message, comment: comment as string[] }];
  }
  return undefined;
}

export function extractMessages(files: SourceText[]): Extraction {
  const messages = new Map<string, ExtractedMessage>();
  const unextractable: string[] = [];
  for (const { name, text } of files) {
    if (!/l10n\.(t|html)\(/.test(text)) continue;
    const sourceFile = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (isL10nCall(node, sourceFile)) {
        const found = readMessages(node.arguments[0]);
        if (found) {
          for (const entry of found) {
            const note = entry.comment?.join('');
            messages.set(note ? `${entry.message}/${note}` : entry.message, entry);
          }
        } else {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          unextractable.push(`${name}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { messages, unextractable };
}

/** English bundle in the format VS Code's tooling writes: text, or text plus comment. */
export function toEnglishBundle(
  messages: Map<string, ExtractedMessage>
): Record<string, string | { message: string; comment: string[] }> {
  const bundle: Record<string, string | { message: string; comment: string[] }> = {};
  for (const key of [...messages.keys()].sort()) {
    const entry = messages.get(key) as ExtractedMessage;
    bundle[key] = entry.comment
      ? { message: entry.message, comment: entry.comment }
      : entry.message;
  }
  return bundle;
}

/** `{0}`, `{1}` placeholders of a message, sorted and without repeats. */
export function placeholders(message: string): string[] {
  return [...new Set(message.match(/\{\d+\}/g) ?? [])].sort();
}
