const READING_WORDS = 3_000;
const STRESS_LINES = 10_000;

const READING_VOCABULARY = Object.freeze(
  'Clear writing helps readers understand decisions context tradeoffs evidence ownership sequence risk and next steps without forcing them to reconstruct the argument from scattered notes'.split(
    ' '
  )
);

const STRESS_PREAMBLE = Object.freeze([
  '---',
  'title: Deterministic Feedback Performance Fixture',
  'owner: performance-harness',
  '---',
  '# Deterministic Feedback Performance Fixture',
  '',
  'This document intentionally mixes every expensive Markdown family used by Feedback.',
  '',
  '- A list item with **strong text** and a [link](https://example.invalid).',
  '- A second list item with `inline code` and escaped punctuation.',
  '',
  '| Column A | Column B |',
  '| --- | ---: |',
  '| Alpha | 1 |',
  '| Beta | 2 |',
  '',
  '![Local fixture image](./assets/performance-fixture.png)',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[Start] --> B[Feedback]',
  '```',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '<aside data-fixture="raw-html">Raw HTML fixture content.</aside>',
  '',
  '```typescript',
  'const deterministic = true;',
  '```',
  '',
]);

/** Build stable prose with exactly 3,000 whitespace-delimited words. */
export function createFeedbackReadingFixture() {
  const words = Array.from(
    { length: READING_WORDS },
    (_, index) => READING_VOCABULARY[index % READING_VOCABULARY.length]
  );
  const paragraphs = [];
  for (let index = 0; index < words.length; index += 100) {
    paragraphs.push(words.slice(index, index + 100).join(' '));
  }
  return paragraphs.join('\n\n');
}

/** Build stable mixed Markdown with exactly 10,000 logical source lines. */
export function createFeedbackStressFixture() {
  const lines = [...STRESS_PREAMBLE];
  while (lines.length < STRESS_LINES) {
    const lineNumber = lines.length + 1;
    lines.push(
      `Paragraph line ${lineNumber}: deterministic content for serialization, indexing, and Feedback anchors.`
    );
  }
  return lines.join('\n');
}

/** Inspect fixture size and required content families without using elapsed time. */
export function inspectFeedbackFixture(markdown) {
  const trimmed = markdown.trim();
  const words = trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
  const lines = markdown.length === 0 ? 0 : markdown.split(/\r?\n/u).length;
  return {
    words,
    lines,
    features: {
      frontmatter: markdown.startsWith('---\n') && markdown.includes('\n---\n'),
      table: /^\|.+\|$/mu.test(markdown) && /^\|\s*---/mu.test(markdown),
      list: /^-\s+/mu.test(markdown),
      image: /!\[[^\]]*\]\([^)]*\)/u.test(markdown),
      mermaid: markdown.includes('```mermaid\n'),
      math: markdown.includes('\n$$\n'),
      rawHtml: /<aside\b/u.test(markdown),
      code: markdown.includes('```typescript\n'),
    },
  };
}
