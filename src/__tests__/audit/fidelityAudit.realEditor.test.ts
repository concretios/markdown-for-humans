/** @jest-environment jsdom */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Source fidelity audit.
 *
 * Loads every sample of fidelityCorpus.ts, and every tracked Markdown file of
 * this repository, into an editor built from production's extension list, and
 * measures four things for each:
 *
 *   untouched  the document is saved with no edit        -> must be identical
 *   elsewhere  another paragraph is edited               -> the sample must be identical
 *   inside     the sample's own text is edited           -> nothing may be lost
 *   feedback   Feedback's snapshot checks                -> must accept the document
 *
 * It asserts nothing about the samples: it writes a report. Run it with
 *
 *   MD4H_FIDELITY_AUDIT=1 npx jest src/__tests__/audit
 *
 * The report goes to MD4H_FIDELITY_AUDIT_OUT, or md4h-fidelity-audit.json in
 * the system temp folder.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import MarkdownIt from 'markdown-it';
import { Marked } from 'marked';
import type { Editor } from '@tiptap/core';
import { buildFeedbackAnchorMap } from '../../editor/feedbackAnchors';
import {
  FeedbackSnapshotService,
  computeFeedbackTextSha256,
} from '../../editor/feedbackSnapshotService';
import {
  hasSameBlankLineLayout,
  isMarkdownRendererEquivalent,
} from '../../editor/markdownAstEquivalence';
import { enumerateCanonicalFeedbackBlocks } from '../../webview/features/feedbackReview';
import {
  getEditorMarkdownForSync,
  setMarkdownContentPreservingSource,
} from '../../webview/utils/markdownSerialization';
import { applyBlankLinePolicy, type BlankLineMode } from '../../shared/blankLinePolicy';
import { describeSourceLoss } from '../../shared/sourceLoss';
import { findFragileBlocks, renderForComparison } from '../../webview/utils/sourceFidelity';
import { createProductionEditor } from '../helpers/productionEditor';
import { FIDELITY_SAMPLES } from './fidelityCorpus';

const EDIT = 'ZZQ';
/** `strip` is the shipped default of `markdownForHumans.blankLines.mode`. */
const BLANK_LINES: BlankLineMode =
  process.env.MD4H_FIDELITY_AUDIT_BLANK_LINES === 'preserve' ? 'preserve' : 'strip';

/**
 * What the host writes for a text the webview sends, as
 * `MarkdownEditorProvider.normalizeWebviewEditContent` does: the blank-line
 * policy, then one final newline. VS Code itself keeps the file's line endings
 * and byte order mark, so both are taken out of the comparison.
 */
const asWritten = (markdown: string): string =>
  `${applyBlankLinePolicy(markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'), BLANK_LINES).replace(/\n+$/, '')}\n`;
const save = (editor: Editor): string => asWritten(getEditorMarkdownForSync(editor, BLANK_LINES));
const REPOSITORY_ROOT = resolve(__dirname, '../../..');

const markdownIt = new MarkdownIt({ html: true, breaks: true, linkify: false });
const squash = (html: string): string => html.replace(/\s+/g, ' ').replace(/> </g, '><').trim();
const viaMarkdownIt = (markdown: string): string => squash(markdownIt.render(markdown));
// A private instance: the editor registers its own tokenizers on the shared one.
const plainMarked = new Marked({ gfm: true, breaks: true, async: false });
const viaMarked = (markdown: string): string => squash(String(plainMarked.parse(markdown)));

/** Source text that renders nothing, so no renderer comparison can see it go missing. */
function silentTokens(markdown: string): string[] {
  return [
    ...(markdown.match(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>\n]*>/g) ?? []),
    ...(markdown.match(/^ {0,3}\[[^\]\n]+\]:[ \t]*\S.*$/gm) ?? []).map(line => line.trim()),
  ];
}

function lostTokens(source: string, output: string): string[] {
  const remaining = silentTokens(output);
  return silentTokens(source).filter(token => {
    const index = remaining.indexOf(token);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
}

/**
 * identical: same text.  rewritten: different text, same rendering in both parsers.
 * dialect: the two parsers disagree on whether it still renders the same.
 * changed: renders differently in both.  lost: tags, comments or definitions are gone.
 */
type Verdict = 'identical' | 'rewritten' | 'dialect' | 'changed' | 'lost' | 'threw' | 'n/a';

interface Outcome {
  verdict: Verdict;
  /** What was lost, or why it threw. */
  detail?: string;
  /** The saved text, when it is not the expected one. */
  output?: string;
}

function compare(expected: string, actual: string): Outcome {
  if (expected === actual) return { verdict: 'identical' };
  const output = actual.slice(0, 600);
  const lost = lostTokens(expected, actual);
  if (lost.length > 0) return { verdict: 'lost', detail: lost.join(' '), output };
  const sameInMarkdownIt = viaMarkdownIt(expected) === viaMarkdownIt(actual);
  const sameInMarked = viaMarked(expected) === viaMarked(actual);
  if (sameInMarkdownIt && sameInMarked) return { verdict: 'rewritten', output };
  return { verdict: sameInMarkdownIt || sameInMarked ? 'dialect' : 'changed', output };
}

const SEVERITY: Verdict[] = [
  'n/a',
  'identical',
  'rewritten',
  'dialect',
  'changed',
  'lost',
  'threw',
];
const worse = (a: Outcome, b: Outcome): Outcome =>
  SEVERITY.indexOf(b.verdict) > SEVERITY.indexOf(a.verdict) ? b : a;

interface TextSpot {
  end: number;
  block: number;
}

function textSpots(editor: Editor): TextSpot[] {
  const spots: TextSpot[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.isText) {
      spots.push({
        end: position + node.nodeSize,
        block: editor.state.doc.resolve(position).index(0),
      });
    }
    return true;
  });
  return spots;
}

function attempt(run: () => Outcome): Outcome {
  try {
    return run();
  } catch (error) {
    return { verdict: 'threw', detail: error instanceof Error ? error.message : String(error) };
  }
}

const snapshotService = new FeedbackSnapshotService();

/** The checks `MarkdownEditorProvider` runs before a Feedback session may start. */
function feedbackOutcome(editor: Editor, source: string): string {
  try {
    const rendered = save(editor);
    const written = asWritten(source);
    if (
      rendered !== written &&
      !(
        isMarkdownRendererEquivalent(rendered, written) &&
        (BLANK_LINES !== 'preserve' || hasSameBlankLineLayout(rendered, written))
      )
    ) {
      return 'rendered Markdown differs from the saved file';
    }

    const blocks = enumerateCanonicalFeedbackBlocks(editor);
    if (blocks.length === 0) return 'ok';
    const anchors = buildFeedbackAnchorMap(source, blocks);
    if (!anchors.ok) return `${anchors.error.reason}: ${anchors.error.detail}`;

    // Built by hand: `prepareSource` checks `instanceof Uint8Array`, which fails
    // for a Node Buffer inside the jsdom realm.
    const sha256 = computeFeedbackTextSha256(source);
    const prepared = {
      documentUri: 'file:///audit/sample.md',
      operationId: 'audit',
      documentVersion: 1,
      sourceText: source,
      sourceTextSha256: sha256,
      savedBytesSha256: sha256,
      sourceByteCount: Buffer.byteLength(source, 'utf8'),
    };
    const identity = {
      viewId: 'view',
      viewGeneration: 'view:g1',
      localRevision: 1,
      documentVersion: 1,
      contentSha256: sha256,
    };
    const finalized = snapshotService.finalize({
      source: prepared,
      currentDocumentVersion: 1,
      splitReports: [{ ...identity, dirty: false }],
      renderer: { ...identity, canonicalDescriptorRevision: 1 },
      descriptors: { revision: 1, blocks },
    });
    return finalized.ok ? 'ok' : finalized.error.reason;
  } catch (error) {
    return `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** What the loss scan says right after load, before any edit. */
interface GuardPrediction {
  /** The untouched document already lacks tags, comments or definitions. */
  unheld: boolean;
  /** A block would lose tags, comments or definitions if edited. */
  fragileByName: boolean;
  /** A block would lose those, or render differently, if edited. */
  fragileByRendering: boolean;
}

interface AuditRow {
  category: string;
  name: string;
  untouched: Outcome;
  elsewhere: Outcome;
  inside: Outcome;
  feedback: string;
  guard: GuardPrediction;
}

const TAIL = 'Tail paragraph.';

/**
 * Audit one sample.
 *
 * @param editor - Reused across samples; every run replaces its whole content
 * @param sample - Markdown of the sample alone
 * @param wholeDocument - Use the sample as the document instead of framing it
 */
function auditSample(
  editor: Editor,
  sample: string,
  wholeDocument = false
): Omit<AuditRow, 'category' | 'name'> {
  const source = wholeDocument ? sample : `# Title\n\n${sample}\n\n${TAIL}`;
  const load = (): void => {
    setMarkdownContentPreservingSource(editor, source);
  };

  const untouched = attempt(() => {
    load();
    return compare(asWritten(source), save(editor));
  });
  const feedback =
    untouched.verdict === 'threw' ? 'threw on load' : feedbackOutcome(editor, source);

  let elsewhere: Outcome = { verdict: 'n/a' };
  let inside: Outcome = { verdict: 'n/a' };
  const guard: GuardPrediction = { unheld: false, fragileByName: false, fragileByRendering: false };
  if (untouched.verdict === 'threw') return { untouched, elsewhere, inside, feedback, guard };

  // In a framed sample the title and the tail are plain text, so a fragile block is the sample's.
  guard.unheld = describeSourceLoss(asWritten(source), save(editor)) !== null;
  guard.fragileByName = findFragileBlocks(editor).length > 0;
  guard.fragileByRendering = findFragileBlocks(editor, renderForComparison).length > 0;

  const spots = textSpots(editor);
  const lastBlock = editor.state.doc.childCount - 1;
  const firstInBlock = new Map<number, TextSpot>();
  for (const spot of spots) if (!firstInBlock.has(spot.block)) firstInBlock.set(spot.block, spot);

  for (const [block, spot] of firstInBlock) {
    // In a framed sample the first block is the title and the last one the tail.
    const isFrame = !wholeDocument && (block === 0 || block === lastBlock);
    if (isFrame && block !== lastBlock) continue;
    const outcome = attempt(() => {
      load();
      editor.commands.insertContentAt(spot.end, EDIT);
      const saved = save(editor);
      return isFrame
        ? compare(asWritten(`${source}${EDIT}`), saved)
        : compare(asWritten(source), saved.replace(EDIT, ''));
    });
    if (isFrame) elsewhere = outcome;
    else inside = worse(inside, outcome);
  }
  return { untouched, elsewhere, inside, feedback, guard };
}

function stripFrontmatter(markdown: string): string {
  const match = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(markdown);
  return match ? markdown.slice(match[0].length) : markdown;
}

/** Top-level blocks of a document, as markdown-it delimits them. */
function topLevelBlocks(markdown: string): string[] {
  const sourceLines = markdown.split(/\r?\n/);
  const blocks: string[] = [];
  for (const token of markdownIt.parse(markdown, {})) {
    if (token.level !== 0 || token.map === null) continue;
    let end = token.map[1];
    while (end > token.map[0] + 1 && (sourceLines[end - 1] ?? '').trim() === '') end -= 1;
    blocks.push(sourceLines.slice(token.map[0], end).join('\n'));
  }
  return blocks;
}

const tally = (rows: AuditRow[], pick: (row: AuditRow) => string): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[pick(row)] = (counts[pick(row)] ?? 0) + 1;
  return counts;
};

const summarize = (rows: AuditRow[]): Record<string, unknown> => ({
  samples: rows.length,
  untouched: tally(rows, row => row.untouched.verdict),
  elsewhere: tally(rows, row => row.elsewhere.verdict),
  inside: tally(rows, row => row.inside.verdict),
  feedback: tally(rows, row => (row.feedback === 'ok' ? 'ok' : row.feedback.split(':')[0])),
});

const LOSSY: Verdict[] = ['lost', 'changed', 'dialect'];

/** How well the scan at load predicts what an edit inside the sample then does. */
function guardAccuracy(rows: AuditRow[], pick: (guard: GuardPrediction) => boolean): object {
  const counts = { caught: 0, missed: 0, falseAlarm: 0, quiet: 0 };
  const missed: string[] = [];
  const falseAlarm: string[] = [];
  for (const row of rows) {
    if (row.inside.verdict === 'n/a' || row.inside.verdict === 'threw') continue;
    const lossy = LOSSY.includes(row.inside.verdict);
    const flagged = pick(row.guard) || row.guard.unheld;
    if (lossy && flagged) counts.caught += 1;
    else if (lossy) missed.push(row.name);
    else if (flagged) falseAlarm.push(`${row.name} (${row.inside.verdict})`);
    else counts.quiet += 1;
  }
  counts.missed = missed.length;
  counts.falseAlarm = falseAlarm.length;
  return { ...counts, missed: missed.slice(0, 40), falseAlarms: falseAlarm.slice(0, 40), counts };
}

const isClean = (row: AuditRow): boolean =>
  row.untouched.verdict === 'identical' &&
  ['identical', 'n/a'].includes(row.elsewhere.verdict) &&
  ['identical', 'rewritten', 'n/a'].includes(row.inside.verdict) &&
  row.feedback === 'ok';

const audit = process.env.MD4H_FIDELITY_AUDIT ? describe : describe.skip;

audit('source fidelity audit', () => {
  it('writes the fidelity report', () => {
    const editor = createProductionEditor();
    const quiet = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const quietError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const shapes: AuditRow[] = FIDELITY_SAMPLES.map(sample => ({
        category: sample.category,
        name: sample.name,
        ...auditSample(editor, sample.markdown, sample.wholeDocument === true),
      }));

      const files = execFileSync('git', ['ls-files', '*.md'], {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean);
      const documents: AuditRow[] = [];
      const seenBlocks = new Map<string, string>();
      for (const file of files) {
        const text = stripFrontmatter(readFileSync(join(REPOSITORY_ROOT, file), 'utf8'));
        const body = text.replace(/\s+$/, '');
        if (body === '') continue;
        // Only the checks that need the whole document; blocks are edited one by one below.
        const whole = `${body}\n\n${TAIL}`;
        const untouched = attempt(() => {
          setMarkdownContentPreservingSource(editor, whole);
          return compare(asWritten(whole), save(editor));
        });
        const feedback =
          untouched.verdict === 'threw' ? 'threw on load' : feedbackOutcome(editor, whole);
        const elsewhere = attempt(() => {
          const spots = textSpots(editor);
          editor.commands.insertContentAt(spots[spots.length - 1].end, EDIT);
          return compare(asWritten(`${whole}${EDIT}`), save(editor));
        });
        documents.push({
          category: 'repository file',
          name: file,
          untouched,
          elsewhere,
          inside: { verdict: 'n/a' },
          feedback,
          guard: { unheld: false, fragileByName: false, fragileByRendering: false },
        });
        for (const block of topLevelBlocks(body))
          if (!seenBlocks.has(block)) seenBlocks.set(block, file);
      }

      const blocks: AuditRow[] = [...seenBlocks].map(([block, file]) => ({
        category: 'repository block',
        name: `${file}: ${JSON.stringify(block.slice(0, 160))}`,
        ...auditSample(editor, block),
      }));

      const report = {
        generated: new Date().toISOString(),
        blankLines: BLANK_LINES,
        summary: {
          shapes: summarize(shapes),
          byCategory: Object.fromEntries(
            [...new Set(shapes.map(row => row.category))].map(category => [
              category,
              summarize(shapes.filter(row => row.category === category)),
            ])
          ),
          repositoryFiles: summarize(documents),
          repositoryBlocks: summarize(blocks),
          guard: {
            shapesByName: guardAccuracy(shapes, guard => guard.fragileByName),
            shapesByRendering: guardAccuracy(shapes, guard => guard.fragileByRendering),
            repositoryBlocksByName: guardAccuracy(blocks, guard => guard.fragileByName),
            repositoryBlocksByRendering: guardAccuracy(blocks, guard => guard.fragileByRendering),
          },
        },
        shapes,
        repositoryFiles: documents.filter(row => !isClean(row)),
        repositoryBlocks: blocks.filter(row => !isClean(row)),
      };
      const target =
        process.env.MD4H_FIDELITY_AUDIT_OUT ?? join(tmpdir(), 'md4h-fidelity-audit.json');
      writeFileSync(target, JSON.stringify(report, null, 1));
      expect(shapes.length).toBe(FIDELITY_SAMPLES.length);
    } finally {
      quiet.mockRestore();
      quietError.mockRestore();
      editor.destroy();
      document.body.replaceChildren();
    }
  }, 900_000);
});
