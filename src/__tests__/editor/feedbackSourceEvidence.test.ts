/**
 * Direct contract tests for host-owned Feedback source evidence projection.
 */

import { createHash } from 'crypto';
import {
  FeedbackSourceEvidenceError,
  createFeedbackSourceIndex,
  projectFeedbackSourceEvidence,
  type FeedbackSourceEvidenceProjection,
  type FeedbackSourceIndex,
} from '../../editor/feedbackSourceEvidence';

const DEFAULT_BUDGET = 64 * 1024;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function project(
  source: FeedbackSourceIndex,
  overrides: Partial<Parameters<typeof projectFeedbackSourceEvidence>[1]> = {}
): FeedbackSourceEvidenceProjection {
  return projectFeedbackSourceEvidence(source, {
    startLine: 1,
    endLine: 1,
    relationship: 'selected-blocks',
    format: 'markdown',
    itemUtf8Budget: DEFAULT_BUDGET,
    remainingAggregateUtf8Budget: DEFAULT_BUDGET,
    ...overrides,
  });
}

function expectEvidenceError(
  operation: () => unknown,
  code: FeedbackSourceEvidenceError['code']
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(FeedbackSourceEvidenceError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected FeedbackSourceEvidenceError ${code}.`);
}

describe('Feedback saved-source index', () => {
  it('binds the exact saved bytes, detects a leading UTF-8 BOM, and indexes mixed terminators', () => {
    const raw = Buffer.from('\ufeff😀\nélan\r\n中\rdone', 'utf8');
    const source = createFeedbackSourceIndex(raw);

    expect({
      sourceBytesSha256: source.sourceBytesSha256,
      sourceByteLength: source.sourceByteLength,
      hasUtf8Bom: source.hasUtf8Bom,
      lineCount: source.lines.length,
      lines: source.lines,
    }).toEqual({
      sourceBytesSha256: sha256(raw),
      sourceByteLength: 23,
      hasUtf8Bom: true,
      lineCount: 4,
      lines: [
        {
          line: 1,
          startByteOffset: 3,
          endByteOffset: 7,
          terminatorEndByteOffset: 8,
          terminator: 'lf',
        },
        {
          line: 2,
          startByteOffset: 8,
          endByteOffset: 13,
          terminatorEndByteOffset: 15,
          terminator: 'crlf',
        },
        {
          line: 3,
          startByteOffset: 15,
          endByteOffset: 18,
          terminatorEndByteOffset: 19,
          terminator: 'cr',
        },
        {
          line: 4,
          startByteOffset: 19,
          endByteOffset: 23,
          terminatorEndByteOffset: 23,
          terminator: 'none',
        },
      ],
    });
  });

  it('indexes an empty source and the empty logical line after a final terminator', () => {
    const empty = createFeedbackSourceIndex(Buffer.alloc(0));
    const terminated = createFeedbackSourceIndex(Buffer.from('one\r\n', 'utf8'));

    expect(empty.lines).toEqual([
      {
        line: 1,
        startByteOffset: 0,
        endByteOffset: 0,
        terminatorEndByteOffset: 0,
        terminator: 'none',
      },
    ]);
    expect(terminated.lines).toEqual([
      {
        line: 1,
        startByteOffset: 0,
        endByteOffset: 3,
        terminatorEndByteOffset: 5,
        terminator: 'crlf',
      },
      {
        line: 2,
        startByteOffset: 5,
        endByteOffset: 5,
        terminatorEndByteOffset: 5,
        terminator: 'none',
      },
    ]);
  });

  it('fatally rejects malformed UTF-8 without replacement decoding', () => {
    expectEvidenceError(
      () => createFeedbackSourceIndex(Uint8Array.from([0x61, 0xc3, 0x28])),
      'invalid-utf8'
    );
    expectEvidenceError(
      () => createFeedbackSourceIndex(Uint8Array.from([0xef, 0xbb, 0xbf, 0xf0, 0x9f])),
      'invalid-utf8'
    );
  });

  it('defensively owns the indexed bytes so caller mutation cannot break the hash binding', () => {
    const input = Uint8Array.from(Buffer.from('original', 'utf8'));
    const source = createFeedbackSourceIndex(input);
    input.fill(0x78);

    const result = project(source);
    expect(result.evidence).toMatchObject({
      availability: 'embedded',
      text: 'original',
    });
    expect(result.sourceBytesSha256).toBe(sha256('original'));
  });
});

describe('Feedback saved-source projection', () => {
  it('normalizes an inclusive mixed-ending span while excluding BOM and the final line terminator', () => {
    const raw = Buffer.from('\ufeff# Ω\r\n\r\nParagraph α\r\r\nLast λ\r\n', 'utf8');
    const source = createFeedbackSourceIndex(raw);
    const normalizedText = '# Ω\n\nParagraph α\n\nLast λ';
    const result = project(source, { startLine: 1, endLine: 5 });

    expect(result).toEqual({
      sourceBytesSha256: sha256(raw),
      sourceByteLength: raw.byteLength,
      hasUtf8Bom: true,
      sourceLineCount: 6,
      startLine: 1,
      endLine: 5,
      sourceByteRange: { startByteOffset: 3, endByteOffset: 33 },
      normalizedByteLength: Buffer.byteLength(normalizedText, 'utf8'),
      sourceSliceSha256: sha256(normalizedText),
      aggregateUtf8BytesConsumed: Buffer.byteLength(normalizedText, 'utf8'),
      evidence: {
        kind: 'source',
        fidelity: 'source-exact',
        relationship: 'selected-blocks',
        format: 'markdown',
        normalization: 'lf',
        sourceSliceSha256: sha256(normalizedText),
        availability: 'embedded',
        text: normalizedText,
        utf8Bytes: Buffer.byteLength(normalizedText, 'utf8'),
      },
    });
  });

  it('uses UTF-8 byte offsets for Unicode lines and keeps only internal delimiters', () => {
    const source = createFeedbackSourceIndex(Buffer.from('\ufeff😀\nélan\r\n中\rdone', 'utf8'));
    const result = project(source, { startLine: 2, endLine: 3 });

    expect(result.sourceByteRange).toEqual({ startByteOffset: 8, endByteOffset: 18 });
    expect(result.normalizedByteLength).toBe(9);
    expect(result.evidence).toMatchObject({
      availability: 'embedded',
      text: 'élan\n中',
      utf8Bytes: 9,
    });
  });

  it('removes only the file-leading BOM and preserves a selected U+FEFF character', () => {
    const source = createFeedbackSourceIndex(Buffer.from('\ufefffirst\n\ufeffsecond', 'utf8'));
    const selectedText = '\ufeffsecond';
    const result = project(source, { startLine: 2, endLine: 2 });

    expect(result.evidence).toEqual({
      kind: 'source',
      fidelity: 'source-exact',
      relationship: 'selected-blocks',
      format: 'markdown',
      normalization: 'lf',
      sourceSliceSha256: sha256(selectedText),
      availability: 'embedded',
      text: selectedText,
      utf8Bytes: Buffer.byteLength(selectedText, 'utf8'),
    });
  });

  it('includes a final source newline only when the following empty logical line is selected', () => {
    const source = createFeedbackSourceIndex(Buffer.from('first\r\nsecond\n', 'utf8'));

    expect(project(source, { startLine: 1, endLine: 2 }).evidence).toMatchObject({
      availability: 'embedded',
      text: 'first\nsecond',
    });
    expect(project(source, { startLine: 1, endLine: 3 }).evidence).toMatchObject({
      availability: 'embedded',
      text: 'first\nsecond\n',
    });
  });

  it('embeds the complete slice at exact item and aggregate byte limits', () => {
    const source = createFeedbackSourceIndex(Buffer.from('Ωx', 'utf8'));
    const result = project(source, {
      itemUtf8Budget: 3,
      remainingAggregateUtf8Budget: 3,
      relationship: 'containing-blocks',
      format: 'html',
    });

    expect(result.aggregateUtf8BytesConsumed).toBe(3);
    expect(result.evidence).toEqual({
      kind: 'source',
      fidelity: 'source-exact',
      relationship: 'containing-blocks',
      format: 'html',
      normalization: 'lf',
      sourceSliceSha256: sha256('Ωx'),
      availability: 'embedded',
      text: 'Ωx',
      utf8Bytes: 3,
    });
  });

  it.each([
    ['item budget', { itemUtf8Budget: 2, remainingAggregateUtf8Budget: 3 }],
    ['remaining aggregate budget', { itemUtf8Budget: 3, remainingAggregateUtf8Budget: 2 }],
  ])('omits the complete slice when the %s is one UTF-8 byte short', (_label, budgets) => {
    const source = createFeedbackSourceIndex(Buffer.from('Ωx', 'utf8'));
    const result = project(source, budgets);

    expect(result.aggregateUtf8BytesConsumed).toBe(0);
    expect(result.evidence).toEqual({
      kind: 'source',
      fidelity: 'source-reference',
      relationship: 'selected-blocks',
      format: 'markdown',
      normalization: 'lf',
      sourceSliceSha256: sha256('Ωx'),
      availability: 'omitted',
      omittedReason: 'evidence-budget',
      omittedUtf8Bytes: 3,
    });
    expect(Object.prototype.hasOwnProperty.call(result.evidence, 'text')).toBe(false);
  });

  it('omits unsafe controls without leaking selected text and still binds its size and hash', () => {
    const unsafeText = 'safe\tcontext\u0000DO-NOT-LEAK';
    const source = createFeedbackSourceIndex(Buffer.from(`${unsafeText}\nnext`, 'utf8'));
    const result = project(source, {
      itemUtf8Budget: 0,
      remainingAggregateUtf8Budget: 0,
    });

    expect(result.aggregateUtf8BytesConsumed).toBe(0);
    expect(result.evidence).toEqual({
      kind: 'source',
      fidelity: 'source-reference',
      relationship: 'selected-blocks',
      format: 'markdown',
      normalization: 'lf',
      sourceSliceSha256: sha256(unsafeText),
      availability: 'omitted',
      omittedReason: 'unsafe-control',
      omittedUtf8Bytes: Buffer.byteLength(unsafeText, 'utf8'),
    });
    expect(JSON.stringify(result)).not.toContain('DO-NOT-LEAK');
    expect(JSON.stringify(result)).not.toContain('\u0000');
  });

  it('allows tabs and rejects C1 controls in otherwise valid UTF-8', () => {
    const safe = createFeedbackSourceIndex(Buffer.from('one\ttwo', 'utf8'));
    const unsafe = createFeedbackSourceIndex(Buffer.from('one\u0085two', 'utf8'));

    expect(project(safe).evidence).toMatchObject({
      availability: 'embedded',
      text: 'one\ttwo',
    });
    expect(project(unsafe).evidence).toMatchObject({
      availability: 'omitted',
      omittedReason: 'unsafe-control',
    });
  });

  it('embeds an empty selected line without consuming either budget', () => {
    const result = project(createFeedbackSourceIndex(Buffer.alloc(0)), {
      itemUtf8Budget: 0,
      remainingAggregateUtf8Budget: 0,
      format: 'text',
    });

    expect(result.aggregateUtf8BytesConsumed).toBe(0);
    expect(result.evidence).toMatchObject({
      availability: 'embedded',
      text: '',
      utf8Bytes: 0,
    });
  });

  it.each([
    [0, 1],
    [2, 1],
    [1, 2],
    [1.5, 1],
  ])('rejects an invalid inclusive line span %s-%s', (startLine, endLine) => {
    const source = createFeedbackSourceIndex(Buffer.from('only', 'utf8'));
    expectEvidenceError(() => project(source, { startLine, endLine }), 'invalid-line-span');
  });

  it.each([
    ['itemUtf8Budget', -1],
    ['itemUtf8Budget', 1.5],
    ['remainingAggregateUtf8Budget', -1],
    ['remainingAggregateUtf8Budget', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('rejects invalid %s values', (name, value) => {
    const source = createFeedbackSourceIndex(Buffer.from('only', 'utf8'));
    expectEvidenceError(() => project(source, { [name]: value }), 'invalid-budget');
  });
});
