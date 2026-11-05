import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { getLevenshteinDistance } from './levenshtein';
import {
  buildHeadingAnchors,
  generateHeadingSlug,
  headingAnchorText,
  resolveHeadingAnchor,
  toFragmentKey,
  type HeadingTexts,
  type SeenSlugs,
} from '../utils/headingSlug';
import * as l10n from '../l10n';

export type AuditIssueType = 'link' | 'image' | 'heading';

/** File type filter hint passed to the extension when opening a file picker */
export type AuditFileType = 'image' | 'any';

export interface AuditIssue {
  type: AuditIssueType;
  message: string;
  pos: number;
  nodeSize: number;
  target: string;
  suggestions?: string[];
  /** A heading link in a form earlier versions wrote: it jumps here, but is dead on GitHub. */
  olderFormAnchor?: boolean;
}

export interface FileCheckResult {
  exists: boolean;
  suggestions?: string[];
  timedOut?: boolean;
}

export type UrlCheckResult = 'reachable' | 'unreachable' | 'timeout';

function findBestMatches(target: string, candidates: string[], maxDistance: number = 3): string[] {
  const matches = candidates
    .map(c => ({ candidate: c, distance: getLevenshteinDistance(target, c) }))
    .filter(x => x.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .map(x => x.candidate);

  // For headings, also try some intelligent transformations
  if (matches.length === 0 && target.length > 3) {
    const transformedCandidates: string[] = [];

    // Try removing common prefixes/suffixes that might have changed
    const prefixes = ['the-', 'a-', 'an-', 'my-', 'our-', 'your-'];
    const suffixes = ['-section', '-part', '-chapter', '-guide'];

    for (const prefix of prefixes) {
      if (target.startsWith(prefix)) {
        const withoutPrefix = target.slice(prefix.length);
        transformedCandidates.push(withoutPrefix);
      }
    }

    for (const suffix of suffixes) {
      if (target.endsWith(suffix)) {
        const withoutSuffix = target.slice(0, -suffix.length);
        transformedCandidates.push(withoutSuffix);
      }
    }

    // Try normalizing spaces and case
    const normalizedTarget = target.toLowerCase().replace(/[-_\s]+/g, '-');
    transformedCandidates.push(normalizedTarget);

    // Find matches for transformed versions
    for (const transformed of transformedCandidates) {
      const transformedMatches = candidates
        .map(c => ({ candidate: c, distance: getLevenshteinDistance(transformed, c) }))
        .filter(x => x.distance <= maxDistance)
        .sort((a, b) => a.distance - b.distance)
        .map(x => x.candidate);

      matches.push(...transformedMatches);
    }
  }

  // Remove duplicates and limit results
  return Array.from(new Set(matches)).slice(0, 5);
}

export async function runAudit(editor: Editor): Promise<AuditIssue[]> {
  // Clear existing decorations while auditing
  editor.view.dispatch(editor.state.tr.setMeta(auditPluginKey, []));

  const issues: AuditIssue[] = [];
  const { doc } = editor.state;

  const existingSlugs: SeenSlugs = new Map();
  const headings: HeadingTexts[] = [];
  const currentAnchors: string[] = [];
  const fileChecks: Promise<void>[] = [];
  const headingLinks: { slug: string; pos: number; nodeSize: number }[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const anchorText = headingAnchorText(node);
      currentAnchors.push(generateHeadingSlug(anchorText, existingSlugs));
      headings.push({ text: node.textContent, anchorText });
    }

    // Truly-empty image syntax `![]()` is rewritten to literal text by the
    // marked lexer normaliser so it survives the parse round-trip (see
    // markedLexerNormalizer.ts). The audit must scan text nodes for these
    // patterns because they never appear as image nodes in the doc.
    if (node.isText && typeof node.text === 'string' && node.text.includes('![')) {
      const emptyImageRegex = /!\[\s*\]\(\s*\)/g;
      let match;
      while ((match = emptyImageRegex.exec(node.text)) !== null) {
        issues.push({
          type: 'image',
          message: l10n.t('Image has no source path.'),
          pos: pos + match.index,
          nodeSize: match[0].length,
          target: '',
        });
      }
    }

    if (node.type.name === 'image' || node.type.name === 'customImage') {
      const src = node.attrs.src;
      if (!src) {
        issues.push({
          type: 'image',
          message: l10n.t('Image has no source path.'),
          pos,
          nodeSize: node.nodeSize,
          target: '',
        });
      } else if (
        !src.startsWith('http://') &&
        !src.startsWith('https://') &&
        !src.startsWith('data:')
      ) {
        fileChecks.push(
          checkFileExistence(src).then(result => {
            if (!result.exists) {
              issues.push({
                type: 'image',
                message: l10n.t('Image file not found: {0}', src),
                pos,
                nodeSize: node.nodeSize,
                target: src,
                suggestions: result.suggestions,
              });
            }
          })
        );
      } else if (src.startsWith('http://') || src.startsWith('https://')) {
        fileChecks.push(
          checkUrlStatus(src).then(status => {
            if (status === 'timeout') {
              issues.push({
                type: 'image',
                message: l10n.t('Verification timed out for image: {0}', src),
                pos,
                nodeSize: node.nodeSize,
                target: src,
              });
            } else if (status === 'unreachable') {
              issues.push({
                type: 'image',
                message: l10n.t('Broken image URL: {0}', src),
                pos,
                nodeSize: node.nodeSize,
                target: src,
              });
            }
          })
        );
      }
    }

    if (node.marks && node.marks.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const linkMark = node.marks.find((m: any) => m.type.name === 'link');
      if (linkMark) {
        const href = linkMark.attrs.href;
        if (!href) {
          issues.push({
            type: 'link',
            message: l10n.t('Link is empty.'),
            pos,
            nodeSize: node.nodeSize,
            target: '',
          });
        } else if (href.startsWith('#')) {
          headingLinks.push({ slug: href.slice(1), pos, nodeSize: node.nodeSize });
        } else if (
          !href.startsWith('http://') &&
          !href.startsWith('https://') &&
          !href.startsWith('mailto:')
        ) {
          fileChecks.push(
            checkFileExistence(href).then(result => {
              if (result.timedOut) {
                issues.push({
                  type: 'link',
                  message: l10n.t('Verification timed out for local File: {0}', href),
                  pos,
                  nodeSize: node.nodeSize,
                  target: href,
                });
              } else if (!result.exists) {
                issues.push({
                  type: 'link',
                  message: l10n.t('Linked file not found: {0}', href),
                  pos,
                  nodeSize: node.nodeSize,
                  target: href,
                  suggestions: result.suggestions,
                });
              }
            })
          );
        } else if (href.startsWith('http://') || href.startsWith('https://')) {
          fileChecks.push(
            checkUrlStatus(href).then(status => {
              if (status === 'timeout') {
                issues.push({
                  type: 'link',
                  message: l10n.t('Verification timed out for link: {0}', href),
                  pos,
                  nodeSize: node.nodeSize,
                  target: href,
                });
              } else if (status === 'unreachable') {
                issues.push({
                  type: 'link',
                  message: l10n.t('Broken link URL: {0}', href),
                  pos,
                  nodeSize: node.nodeSize,
                  target: href,
                });
              }
            })
          );
        }
      }
    }
  });

  await Promise.all(fileChecks);

  const anchors = buildHeadingAnchors(headings);
  const currentAnchorKeys = new Map(
    currentAnchors.map((anchor, index) => [toFragmentKey(anchor), index])
  );
  headingLinks.forEach(link => {
    // A bare # is the top of the page on GitHub, and an older link to a heading with no
    // ASCII letters here. The file cannot tell the two apart, and neither is broken.
    if (!link.slug) return;

    const headingIndex = resolveHeadingAnchor(anchors, link.slug);
    if (headingIndex === undefined) {
      const suggestions = findBestMatches(
        toFragmentKey(link.slug),
        Array.from(existingSlugs.keys()).filter(Boolean)
      );
      issues.push({
        type: 'heading',
        message: l10n.t('Heading anchor not found: #{0}', link.slug),
        pos: link.pos,
        nodeSize: link.nodeSize,
        target: link.slug,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
      });
    } else if (
      // It reached a heading, but only through a form earlier versions wrote. GitHub has no
      // such id. Compare by resolving, so every spelling of a current anchor stays clean.
      currentAnchors[headingIndex] &&
      resolveHeadingAnchor(currentAnchorKeys, link.slug) === undefined
    ) {
      issues.push({
        type: 'heading',
        message: l10n.t('Link works in this editor but not on GitHub: #{0}', link.slug),
        pos: link.pos,
        nodeSize: link.nodeSize,
        target: link.slug,
        suggestions: [currentAnchors[headingIndex]],
        olderFormAnchor: true,
      });
    }
  });

  return issues;
}

const auditCheckCallbacks = new Map<string, (result: FileCheckResult) => void>();
const auditUrlCheckCallbacks = new Map<string, (reachable: boolean) => void>();

export function handleAuditCheckResult(requestId: string, exists: boolean, suggestions?: string[]) {
  const cb = auditCheckCallbacks.get(requestId);
  if (cb) {
    cb({ exists, suggestions });
    auditCheckCallbacks.delete(requestId);
  }
}

export function handleAuditUrlCheckResult(requestId: string, reachable: boolean) {
  const cb = auditUrlCheckCallbacks.get(requestId);
  if (cb) {
    cb(reachable);
    auditUrlCheckCallbacks.delete(requestId);
  }
}

// --- File picker (Browse button) request/response ----------------------------

/**
 * Callbacks awaiting a 'auditPickFileResult' response from the extension host.
 * Key: requestId, Value: resolve function
 */
const auditPickFileCallbacks = new Map<string, (path: string | null) => void>();

/**
 * Open a file picker dialog in the extension host and return the selected path
 * relative to the document, or null if the user cancelled.
 *
 * @param fileType - Filter hint: 'image' shows only image files, 'any' shows all files.
 * @returns Relative path chosen by the user, or null on cancel.
 */
export function requestFilePickerForIssue(fileType: AuditFileType): Promise<string | null> {
  return new Promise(resolve => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vscodeApi = (window as any).vscode;
    if (!vscodeApi) {
      resolve(null);
      return;
    }
    const requestId = `audit-pick-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    auditPickFileCallbacks.set(requestId, resolve);

    // Safety-net timeout (5 minutes) to prevent memory leaks if the extension host crashes.
    // We DO NOT use a short timeout here because OS file pickers are user-driven,
    // and users may legitimately take several minutes to locate a specific file.
    // Standard user cancellations are handled natively by the extension host returning null.
    setTimeout(() => {
      if (auditPickFileCallbacks.has(requestId)) {
        auditPickFileCallbacks.delete(requestId);
        resolve(null);
      }
    }, 300000);

    vscodeApi.postMessage({
      type: 'auditPickFile',
      requestId,
      fileType,
    });
  });
}

/**
 * Called by the webview message handler when the extension replies with the
 * user's file selection (or null for cancel).
 *
 * @param requestId - Must match the id from requestFilePickerForIssue.
 * @param selectedPath - Relative path chosen, or null if cancelled.
 */
export function handleAuditPickFileResult(requestId: string, selectedPath: string | null): void {
  const cb = auditPickFileCallbacks.get(requestId);
  if (cb) {
    cb(selectedPath);
    auditPickFileCallbacks.delete(requestId);
  }
}

function checkFileExistence(relativePath: string): Promise<FileCheckResult> {
  return new Promise(resolve => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vscodeApi = (window as any).vscode;
    if (!vscodeApi) {
      resolve({ exists: true });
      return;
    }
    const requestId = `audit-check-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const timeout = setTimeout(() => {
      if (auditCheckCallbacks.has(requestId)) {
        auditCheckCallbacks.delete(requestId);
        resolve({ exists: false, timedOut: true }); // <-- Explicitly mark as timed out
      }
    }, 2000);

    auditCheckCallbacks.set(requestId, (result: FileCheckResult) => {
      clearTimeout(timeout);
      resolve({ ...result, timedOut: false });
    });

    vscodeApi.postMessage({
      type: 'auditCheckFile',
      requestId,
      relativePath,
    });
  });
}

function checkUrlStatus(url: string): Promise<UrlCheckResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vscodeApi = (window as any).vscode;
  if (!vscodeApi) {
    return Promise.resolve('unreachable');
  }

  return new Promise(resolve => {
    const requestId = `audit-url-check-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const timeout = setTimeout(() => {
      if (auditUrlCheckCallbacks.has(requestId)) {
        auditUrlCheckCallbacks.delete(requestId);
        resolve('timeout'); // <-- Resolve as timeout instead of false
      }
    }, 2000);

    // Wrap the resolve to clear the timeout if it succeeds
    auditUrlCheckCallbacks.set(requestId, (reachable: boolean) => {
      clearTimeout(timeout);
      resolve(reachable ? 'reachable' : 'unreachable');
    });

    vscodeApi.postMessage({
      type: 'auditCheckUrl',
      requestId,
      url,
    });
  });
}

export const auditPluginKey = new PluginKey('auditDocument');

const auditPlugin = new Plugin({
  key: auditPluginKey,
  state: {
    init() {
      return DecorationSet.empty;
    },
    apply(tr, old) {
      const issues = tr.getMeta(auditPluginKey);
      if (issues) {
        const decos = issues.map((issue: AuditIssue) => {
          return Decoration.inline(issue.pos, issue.pos + issue.nodeSize, {
            // An older-form link works here, so it is a warning, not an error.
            class: issue.olderFormAnchor
              ? 'validation-error-highlight validation-older-anchor'
              : 'validation-error-highlight',
            title: issue.message,
          });
        });
        return DecorationSet.create(tr.doc, decos);
      }
      return old.map(tr.mapping, tr.doc);
    },
  },
  props: {
    decorations(state) {
      return this.getState(state);
    },
  },
});

export const DocumentAuditExtension = Extension.create({
  name: 'documentAudit',
  addProseMirrorPlugins() {
    return [auditPlugin];
  },
});
