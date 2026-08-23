/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import {
  DEFAULT_FEEDBACK_HANDOFF_PROMPT_TEMPLATE,
  FEEDBACK_HANDOFF_PROMPT_TEMPLATE_SETTING,
  MAX_FEEDBACK_HANDOFF_PROMPT_LENGTH,
  MAX_FEEDBACK_HANDOFF_TEMPLATE_LENGTH,
  formatMarkdownInlineCode,
  renderFeedbackHandoffPrompt,
  type FeedbackHandoffPromptValues,
} from '../../editor/feedbackHandoffPrompt';

const VALUES: FeedbackHandoffPromptValues = {
  feedbackFile: '.md4h/feedback/docs/guide.md--round/feedback.md',
  source: 'docs/guide.md',
  sourceSha256: 'a'.repeat(64),
  itemCount: 3,
  round: '20260821T093000Z-k4p9',
};

const BUILT_IN_PROMPT =
  'Implement the sealed feedback bundle at `.md4h/feedback/docs/guide.md--round/feedback.md`. ' +
  'First verify the source SHA-256. Inspect every referenced image. Edit the workspace files ' +
  'required by the feedback, but do not modify or delete the feedback bundle. Address every ' +
  'feedback ID, run appropriate checks, report the outcome per ID, and stop if the source hash differs.';

describe('renderFeedbackHandoffPrompt', () => {
  it('preserves the current detailed handoff prompt as the exact built-in default', () => {
    expect(renderFeedbackHandoffPrompt(undefined, VALUES)).toEqual({
      prompt: BUILT_IN_PROMPT,
      template: 'default',
    });
  });

  it('expands every supported placeholder and normalizes CRLF line endings', () => {
    const configuredTemplate = [
      'Implement {{feedbackFile}}.',
      'Source: {{source}}',
      'SHA-256: {{sourceSha256}}',
      'Items: {{itemCount}}; round: {{round}}',
    ].join('\r\n');

    expect(renderFeedbackHandoffPrompt(configuredTemplate, VALUES)).toEqual({
      prompt: [
        'Implement `.md4h/feedback/docs/guide.md--round/feedback.md`.',
        'Source: `docs/guide.md`',
        `SHA-256: ${'a'.repeat(64)}`,
        'Items: 3; round: 20260821T093000Z-k4p9',
      ].join('\n'),
      template: 'custom',
    });
  });

  it('performs one literal placeholder pass without expanding placeholder text in values', () => {
    const values = {
      ...VALUES,
      feedbackFile: '.md4h/feedback/{{round}}/feedback.md',
      source: 'docs/{{itemCount}}.md',
    };

    expect(
      renderFeedbackHandoffPrompt('Read {{feedbackFile}} for {{source}} in {{round}}.', values)
        .prompt
    ).toBe(
      'Read `.md4h/feedback/{{round}}/feedback.md` for `docs/{{itemCount}}.md` in 20260821T093000Z-k4p9.'
    );
  });

  it('uses adaptive Markdown inline-code delimiters for path placeholders', () => {
    const values = {
      ...VALUES,
      feedbackFile: '.md4h/feedback/a`b/feedback.md',
      source: '`docs/guide.md`',
    };

    expect(renderFeedbackHandoffPrompt('{{feedbackFile}} from {{source}}', values).prompt).toBe(
      '``.md4h/feedback/a`b/feedback.md`` from `` `docs/guide.md` ``'
    );
    expect(formatMarkdownInlineCode('docs/guide.md')).toBe('`docs/guide.md`');
  });

  it('falls back with a structured warning when the required placeholder is missing', () => {
    const result = renderFeedbackHandoffPrompt('Implement the latest feedback.', VALUES);

    expect(result.prompt).toBe(BUILT_IN_PROMPT);
    expect(result.template).toBe('default');
    expect(result.warning).toEqual({
      code: 'missing-required-placeholder',
      message: expect.any(String),
    });
  });

  it('falls back with a structured warning for an unknown placeholder', () => {
    const result = renderFeedbackHandoffPrompt(
      'Implement {{feedbackFile}} for {{assignee}}.',
      VALUES
    );

    expect(result.prompt).toBe(BUILT_IN_PROMPT);
    expect(result.template).toBe('default');
    expect(result.warning).toEqual({
      code: 'unknown-placeholder',
      message: expect.stringContaining('{{assignee}}'),
    });
  });

  it.each([null, 42, false, {}, []] as unknown[])(
    'falls back when the configured value is not a string: %p',
    configuredTemplate => {
      const result = renderFeedbackHandoffPrompt(configuredTemplate, VALUES);

      expect(result.prompt).toBe(BUILT_IN_PROMPT);
      expect(result.warning?.code).toBe('invalid-template-type');
    }
  );

  it.each([
    'Implement {{feedbackFile}} and inspect {{source.',
    'Implement {{feedbackFile}} and inspect source}}.',
    'Implement {{{{feedbackFile}}}}.',
  ])('falls back for malformed placeholder delimiters in %p', configuredTemplate => {
    const result = renderFeedbackHandoffPrompt(configuredTemplate, VALUES);

    expect(result.prompt).toBe(BUILT_IN_PROMPT);
    expect(result.warning?.code).toBe('malformed-placeholder');
  });

  it.each(['\0', '\t', '\u0007', '\u007f', '\u0085'])(
    'falls back for unsafe control character %p',
    controlCharacter => {
      const result = renderFeedbackHandoffPrompt(
        `Implement {{feedbackFile}}.${controlCharacter}Continue.`,
        VALUES
      );

      expect(result.prompt).toBe(BUILT_IN_PROMPT);
      expect(result.warning?.code).toBe('unsafe-control-character');
    }
  );

  it('falls back when the configured template exceeds its UTF-16 length limit', () => {
    const oversizedTemplate = `{{feedbackFile}}${'x'.repeat(MAX_FEEDBACK_HANDOFF_TEMPLATE_LENGTH)}`;

    const result = renderFeedbackHandoffPrompt(oversizedTemplate, VALUES);

    expect(result.prompt).toBe(BUILT_IN_PROMPT);
    expect(result.warning?.code).toBe('template-too-long');
  });

  it('falls back when placeholder expansion exceeds the prompt length limit', () => {
    const result = renderFeedbackHandoffPrompt('{{feedbackFile}}\n{{source}}', {
      ...VALUES,
      source: 'x'.repeat(MAX_FEEDBACK_HANDOFF_PROMPT_LENGTH),
    });

    expect(result.prompt).toBe(BUILT_IN_PROMPT);
    expect(result.warning?.code).toBe('expanded-prompt-too-long');
  });
});

describe('formatMarkdownInlineCode', () => {
  it('pads values that start or end with a backtick or whitespace', () => {
    expect(formatMarkdownInlineCode('`docs/guide.md`')).toBe('`` `docs/guide.md` ``');
    expect(formatMarkdownInlineCode(' docs/guide.md ')).toBe('`  docs/guide.md  `');
  });
});

describe('feedback handoff prompt setting', () => {
  it('contributes the built-in template at resource scope and documents every placeholder', () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')
    ) as {
      contributes: {
        configuration: {
          properties: Record<
            string,
            {
              type?: string;
              default?: string;
              scope?: string;
              editPresentation?: string;
              maxLength?: number;
              markdownDescription?: string;
            }
          >;
        };
      };
    };
    const setting =
      packageJson.contributes.configuration.properties[FEEDBACK_HANDOFF_PROMPT_TEMPLATE_SETTING];

    expect(setting).toMatchObject({
      type: 'string',
      default: DEFAULT_FEEDBACK_HANDOFF_PROMPT_TEMPLATE,
      scope: 'resource',
      editPresentation: 'multilineText',
      maxLength: MAX_FEEDBACK_HANDOFF_TEMPLATE_LENGTH,
    });
    for (const placeholder of [
      '{{feedbackFile}}',
      '{{source}}',
      '{{sourceSha256}}',
      '{{itemCount}}',
      '{{round}}',
    ]) {
      expect(setting.markdownDescription).toContain(`\`${placeholder}\``);
    }
  });
});
