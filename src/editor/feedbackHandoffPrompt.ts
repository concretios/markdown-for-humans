/**
 * @file feedbackHandoffPrompt.ts - Safe feedback handoff prompt templating
 * @description Expands a small, bounded placeholder language without depending
 *              on VS Code state or allowing invalid configuration to block sealing.
 *
 * Key responsibilities:
 * - Preserve the original detailed handoff prompt as the built-in default
 * - Expand supported placeholders in one literal pass
 * - Format workspace-relative paths as safe Markdown inline code
 * - Fall back with a structured warning when configuration is invalid
 */

/** Full VS Code setting key for the resource-scoped handoff prompt template. */
export const FEEDBACK_HANDOFF_PROMPT_TEMPLATE_SETTING =
  'markdownForHumans.feedback.handoffPromptTemplate';

/** Maximum configured-template length, measured in UTF-16 code units. */
export const MAX_FEEDBACK_HANDOFF_TEMPLATE_LENGTH = 16_384;

/** Maximum expanded custom-prompt length, measured in UTF-16 code units. */
export const MAX_FEEDBACK_HANDOFF_PROMPT_LENGTH = 32_768;

/** Original detailed prompt, with only its feedback-file path made replaceable. */
export const DEFAULT_FEEDBACK_HANDOFF_PROMPT_TEMPLATE =
  'Implement the sealed feedback bundle at {{feedbackFile}}. ' +
  'First verify the source SHA-256. Inspect every referenced image. Edit the workspace files ' +
  'required by the feedback, but do not modify or delete the feedback bundle. Address every ' +
  'feedback ID, run appropriate checks, report the outcome per ID, and stop if the source hash differs.';

const SUPPORTED_PLACEHOLDERS = [
  'feedbackFile',
  'source',
  'sourceSha256',
  'itemCount',
  'round',
] as const;
const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;

type FeedbackHandoffPlaceholder = (typeof SUPPORTED_PLACEHOLDERS)[number];

/** Values available to a feedback handoff prompt template. */
export interface FeedbackHandoffPromptValues {
  feedbackFile: string;
  source: string;
  sourceSha256: string;
  itemCount: number;
  round: string;
}

/** Stable reason why a configured template was replaced with the built-in default. */
export type FeedbackHandoffPromptWarningCode =
  | 'invalid-template-type'
  | 'malformed-placeholder'
  | 'missing-required-placeholder'
  | 'unknown-placeholder'
  | 'unsafe-control-character'
  | 'template-too-long'
  | 'expanded-prompt-too-long';

/** Actionable, non-throwing warning for an invalid configured template. */
export interface FeedbackHandoffPromptWarning {
  code: FeedbackHandoffPromptWarningCode;
  message: string;
}

/** Prompt resolution result, including whether the built-in or custom template won. */
export interface FeedbackHandoffPromptResult {
  prompt: string;
  template: 'default' | 'custom';
  warning?: FeedbackHandoffPromptWarning;
}

/**
 * Formats arbitrary path text as a CommonMark inline-code span.
 *
 * The delimiter is always longer than any backtick run in the value. CommonMark
 * padding is added when an edge backtick or whitespace could make the span ambiguous.
 *
 * @param value - Path or other literal text to protect
 * @returns Markdown inline code that preserves the complete value
 */
export function formatMarkdownInlineCode(value: string): string {
  const delimiter = '`'.repeat(Math.max(1, longestBacktickRun(value) + 1));
  const needsPadding = value.startsWith('`') || value.endsWith('`') || /^\s|\s$/.test(value);
  return needsPadding ? `${delimiter} ${value} ${delimiter}` : `${delimiter}${value}${delimiter}`;
}

/**
 * Resolves a configured feedback handoff prompt without throwing.
 *
 * `{{feedbackFile}}` is required. Supported placeholders are replaced exactly
 * once, so placeholder-like text inside a path or other value remains literal.
 * Invalid custom configuration returns the built-in default prompt and a stable warning.
 * Values come from `FeedbackSessionStore.seal()`, which has already bounded and
 * validated the workspace-relative paths, hash, item count, and round.
 *
 * @param configuredTemplate - Resource-scoped template, or undefined for the built-in default
 * @param values - Host-authoritative values from the sealed feedback round
 * @returns Expanded prompt and any non-blocking configuration warning
 */
export function renderFeedbackHandoffPrompt(
  configuredTemplate: unknown,
  values: Readonly<FeedbackHandoffPromptValues>
): FeedbackHandoffPromptResult {
  if (configuredTemplate === undefined) {
    return {
      prompt: expandTemplate(DEFAULT_FEEDBACK_HANDOFF_PROMPT_TEMPLATE, values),
      template: 'default',
    };
  }

  if (typeof configuredTemplate !== 'string') {
    return fallback(values, {
      code: 'invalid-template-type',
      message: 'The configured value must be text. The default prompt was used instead.',
    });
  }

  if (configuredTemplate.length > MAX_FEEDBACK_HANDOFF_TEMPLATE_LENGTH) {
    return fallback(values, {
      code: 'template-too-long',
      message: `The feedback handoff prompt template exceeds ${MAX_FEEDBACK_HANDOFF_TEMPLATE_LENGTH.toLocaleString(
        'en-US'
      )} UTF-16 code units. The default prompt was used instead.`,
    });
  }

  const normalizedTemplate = normalizeLineEndings(configuredTemplate);
  if (hasUnsafeControlCharacter(normalizedTemplate)) {
    return fallback(values, {
      code: 'unsafe-control-character',
      message: 'It contains unsupported control characters. The default prompt was used instead.',
    });
  }

  const parsedPlaceholders = parsePlaceholderNames(normalizedTemplate);
  if (!parsedPlaceholders.ok) {
    return fallback(values, {
      code: 'malformed-placeholder',
      message:
        'It contains unmatched or nested placeholder delimiters. The default prompt was used instead.',
    });
  }

  const placeholders = parsedPlaceholders.names;
  const unknownPlaceholder = placeholders.find(
    placeholder => !isFeedbackHandoffPlaceholder(placeholder)
  );
  if (unknownPlaceholder !== undefined) {
    return fallback(values, {
      code: 'unknown-placeholder',
      message: `It uses the unknown placeholder "{{${unknownPlaceholder}}}". The default prompt was used instead.`,
    });
  }

  if (!placeholders.includes('feedbackFile')) {
    return fallback(values, {
      code: 'missing-required-placeholder',
      message: 'It must include "{{feedbackFile}}". The default prompt was used instead.',
    });
  }

  const prompt = expandTemplate(normalizedTemplate, values);
  if (prompt.length > MAX_FEEDBACK_HANDOFF_PROMPT_LENGTH) {
    return fallback(values, {
      code: 'expanded-prompt-too-long',
      message: `The expanded feedback handoff prompt exceeds ${MAX_FEEDBACK_HANDOFF_PROMPT_LENGTH.toLocaleString(
        'en-US'
      )} UTF-16 code units. The default prompt was used instead.`,
    });
  }

  return { prompt, template: 'custom' };
}

function fallback(
  values: Readonly<FeedbackHandoffPromptValues>,
  warning: FeedbackHandoffPromptWarning
): FeedbackHandoffPromptResult {
  return {
    prompt: expandTemplate(DEFAULT_FEEDBACK_HANDOFF_PROMPT_TEMPLATE, values),
    template: 'default',
    warning,
  };
}

function expandTemplate(template: string, values: Readonly<FeedbackHandoffPromptValues>): string {
  const replacements: Record<FeedbackHandoffPlaceholder, string> = {
    feedbackFile: formatMarkdownInlineCode(values.feedbackFile),
    source: formatMarkdownInlineCode(values.source),
    sourceSha256: values.sourceSha256,
    itemCount: String(values.itemCount),
    round: values.round,
  };

  return template.replace(PLACEHOLDER_PATTERN, (match, placeholder: string) =>
    isFeedbackHandoffPlaceholder(placeholder) ? replacements[placeholder] : match
  );
}

function isFeedbackHandoffPlaceholder(value: string): value is FeedbackHandoffPlaceholder {
  return (SUPPORTED_PLACEHOLDERS as readonly string[]).includes(value);
}

function parsePlaceholderNames(template: string): { ok: true; names: string[] } | { ok: false } {
  const names: string[] = [];
  let index = 0;

  while (index < template.length) {
    if (template.startsWith('}}', index)) {
      return { ok: false };
    }
    if (!template.startsWith('{{', index)) {
      index += 1;
      continue;
    }

    const nameStart = index + 2;
    let nameEnd = nameStart;
    while (nameEnd < template.length && !template.startsWith('}}', nameEnd)) {
      if (template.startsWith('{{', nameEnd)) {
        return { ok: false };
      }
      nameEnd += 1;
    }
    if (nameEnd >= template.length) {
      return { ok: false };
    }

    names.push(template.slice(nameStart, nameEnd));
    index = nameEnd + 2;
  }

  return { ok: true, names };
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function hasUnsafeControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code <= 0x1f && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  for (const match of value.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}
