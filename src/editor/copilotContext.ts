/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * @file copilotContext.ts - GitHub Copilot Chat context attachments
 * @description Turns the host's exact source lines into the attachment the
 *              chat input understands (`workbench.action.chat.open` with
 *              `attachFiles`), and detects whether GitHub Copilot is available.
 *
 *              Chat attachments are identified by `uri + range.toString()`.
 *              A range crossing the extension-host boundary loses its `Range`
 *              prototype, so its `toString()` collapses every range of one file
 *              into the same identity and later contexts would be dropped as
 *              duplicates. Each context therefore also carries its lines as a
 *              URI fragment (`file.md#L10-14`), which keeps every context its
 *              own, individually removable chip while the attached `range`
 *              still names the exact lines for Copilot.
 */

import * as vscode from 'vscode';
import type { AiReferenceLineRange } from './aiReference';

/** Internal command that opens the chat input and accepts attached files. */
export const COPILOT_CHAT_OPEN_COMMAND = 'workbench.action.chat.open';

const COPILOT_CHAT_EXTENSION_ID = 'github.copilot-chat';

/** URI schemes the chat attachment model can resolve to a readable file. */
const ATTACHABLE_SCHEMES = new Set(['file', 'vscode-remote', 'vscode-vfs']);

/** Internal 1-based line range, not `vscode.Range`. */
export interface CopilotChatAttachRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/**
 * Whether the chat input can attach a document of this scheme at all.
 *
 * @param scheme - `document.uri.scheme`
 */
export function isCopilotAttachableScheme(scheme: string): boolean {
  return ATTACHABLE_SCHEMES.has(scheme);
}

/**
 * Fragment identity of one context: `L10-14`, or the empty string when the
 * whole file is attached. Two different line ranges of one file must map to
 * two different fragments.
 *
 * @param range - Exact lines of the saved file, or null for the whole file
 */
export function copilotContextFragment(range: AiReferenceLineRange | null): string {
  return range ? `L${range.startLine}-${range.endLine}` : '';
}

/**
 * Convert exact source lines to the chat's internal 1-based line range.
 *
 * @param documentText - Full text of the saved document
 * @param range - Exact lines, 1-based and inclusive
 */
export function toCopilotChatAttachRange(
  documentText: string,
  range: AiReferenceLineRange
): CopilotChatAttachRange {
  const lineLengths = measureLineLengths(documentText);
  const lastLine = Math.max(1, lineLengths.length);
  const startLineNumber = clamp(range.startLine, 1, lastLine);
  const endLineNumber = clamp(range.endLine, startLineNumber, lastLine);
  return {
    startLineNumber,
    startColumn: 1,
    endLineNumber,
    // One past the final character, matching VS Code's whole-line selection.
    endColumn: lineLengths[endLineNumber - 1] + 1,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/** Character count of every line, without the line separator. */
function measureLineLengths(documentText: string): number[] {
  const lengths: number[] = [];
  let current = 0;
  for (let index = 0; index < documentText.length; index += 1) {
    const code = documentText.charCodeAt(index);
    if (code === 13) {
      lengths.push(current);
      current = 0;
      if (documentText.charCodeAt(index + 1) === 10) {
        index += 1;
      }
    } else if (code === 10) {
      lengths.push(current);
      current = 0;
    } else {
      current += 1;
    }
  }
  lengths.push(current);
  return lengths;
}

/**
 * Whether GitHub Copilot Chat can receive context right now: its extension
 * must be present and the chat command registered.
 */
export async function isCopilotChatAvailable(): Promise<boolean> {
  return isCopilotChatExtensionPresent() && (await isCopilotChatCommandAvailable());
}

/** The Copilot Chat extension is installed and activated. */
export function isCopilotChatExtensionPresent(): boolean {
  return vscode.extensions.getExtension(COPILOT_CHAT_EXTENSION_ID) !== undefined;
}

/** The workbench has registered its chat-open command. */
async function isCopilotChatCommandAvailable(): Promise<boolean> {
  try {
    const commands = await vscode.commands.getCommands(true);
    return commands.includes(COPILOT_CHAT_OPEN_COMMAND);
  } catch (error) {
    console.warn('[MD4H] Could not enumerate commands for GitHub Copilot:', error);
    return false;
  }
}
