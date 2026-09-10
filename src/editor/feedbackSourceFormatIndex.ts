/** Compact prefix counts for repeated format queries over frozen sparse anchors. */
import type { FeedbackSourceEvidenceFormat } from './feedbackSourceEvidence';

/** Index once; each inclusive ordinal-range query performs two binary searches. */
export function createFeedbackSourceFormatIndex(
  entries: readonly { ordinal: number; format: FeedbackSourceEvidenceFormat }[]
): (start: number, end: number) => FeedbackSourceEvidenceFormat {
  const sorted = [...entries].sort((a, b) => a.ordinal - b.ordinal);
  const html = [0],
    markdown = [0];
  sorted.forEach(entry => {
    html.push(html[html.length - 1] + Number(entry.format === 'html'));
    markdown.push(markdown[markdown.length - 1] + Number(entry.format === 'markdown'));
  });
  const lower = (ordinal: number) => {
    let left = 0,
      right = sorted.length;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (sorted[mid].ordinal < ordinal) left = mid + 1;
      else right = mid;
    }
    return left;
  };
  return (start, end) => {
    const from = lower(start),
      to = lower(end + 1),
      count = to - from;
    if (count <= 0) return 'text';
    if (html[to] - html[from] === count) return 'html';
    if (markdown[to] - markdown[from] === count) return 'markdown';
    return 'text';
  };
}
