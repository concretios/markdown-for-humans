/**
 * @file feedbackItemSummaryV2.ts - Renderer-safe projection of durable v2 evidence
 * @description Keeps the existing Feedback item list and highlight protocol
 *              compatible without flattening durable v2 evidence back into
 *              one ambiguous stored Focus field.
 */

import {
  renderFeedbackTableCellsTsvV2,
  type FeedbackCellTargetV1,
  type FeedbackEvidenceV2,
  type FeedbackRenderedRangeV1,
  type FeedbackTextItemV2,
} from '../shared/feedbackEvidenceV2';

/** Legacy-shaped renderer fields derived from, but never persisted over, v2 evidence. */
export interface FeedbackTextItemSummaryProjectionV2 {
  readonly focus: string;
  readonly renderedRange?: FeedbackRenderedRangeV1;
  readonly cellTarget?: FeedbackCellTargetV1;
}

/**
 * Projects one strict v2 text item into the existing renderer summary shape.
 * Exact locators are exposed only while the durable target still claims exact
 * resolution. Degraded targets keep their original evidence visible but never
 * resurrect a stale locator.
 */
export function projectFeedbackTextItemSummaryV2(
  item: FeedbackTextItemV2
): FeedbackTextItemSummaryProjectionV2 {
  const evidence = item.evidence.original ?? item.evidence.effective;
  const focus = feedbackSummaryTextV2(evidence);
  if (item.target.resolution !== 'exact' || item.target.locator === undefined) {
    return { focus };
  }
  return item.target.locator.kind === 'rendered-range'
    ? { focus, renderedRange: item.target.locator.value }
    : { focus, cellTarget: item.target.locator.value };
}

function feedbackSummaryTextV2(evidence: FeedbackEvidenceV2): string {
  switch (evidence.kind) {
    case 'source':
      return evidence.availability === 'embedded'
        ? evidence.text
        : `Source evidence omitted (${evidence.omittedUtf8Bytes.toLocaleString(
            'en-US'
          )} UTF-8 bytes).`;
    case 'table-cells':
      return renderFeedbackTableCellsTsvV2(evidence.rows);
    case 'visual':
      return `Screenshot evidence (${evidence.width.toLocaleString('en-US')} × ${evidence.height.toLocaleString('en-US')}).`;
    case 'rendered-text':
    case 'semantic-text':
    case 'legacy-focus':
      return evidence.text;
  }
}
