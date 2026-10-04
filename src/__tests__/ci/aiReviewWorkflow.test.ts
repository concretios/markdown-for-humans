/**
 * @file aiReviewWorkflow.test.ts
 * @description Guards the v2 AI reviewer workflow against the trigger that
 *              v2 silently skips.
 *
 * concretios/ai-pr-reviewer v2.0.0 admits only pull_request, workflow_dispatch,
 * and exact issue_comment commands. A pull_request_target run exits success
 * with "Excluded event: pull_request_target" and posts nothing.
 */

import { readFileSync } from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const reviewWorkflow = readFileSync(path.join(repoRoot, '.github/workflows/ai-review.yml'), 'utf8');
const requestWorkflow = readFileSync(
  path.join(repoRoot, '.github/workflows/ai-review-request.yml'),
  'utf8'
);
const reviewConfig = readFileSync(path.join(repoRoot, '.ai-review.yml'), 'utf8');

const V2_RELEASE_SHA = '486ca9faf54287d4ac29c5c7bff5d20b2f53d558';

/** Event keys under `on:`, ignoring comments that explain the rejected trigger. */
function triggerBlock(workflow: string): string {
  const start = workflow.search(/^on:\s*$/m);
  const jobs = workflow.search(/^jobs:\s*$/m);
  if (start < 0 || jobs < start) {
    throw new Error('Workflow is missing an on/jobs block');
  }
  return workflow.slice(start, jobs);
}

describe('AI PR reviewer v2 workflows', () => {
  it('does not trigger on pull_request_target, which v2 skips as a success', () => {
    expect(triggerBlock(reviewWorkflow)).not.toMatch(/pull_request_target/);
    expect(triggerBlock(requestWorkflow)).not.toMatch(/pull_request_target/);
  });

  it('reviews same-repo pull requests and lets maintainers dispatch from the default branch', () => {
    expect(reviewWorkflow).toMatch(/^\s*pull_request:\s*$/m);
    expect(reviewWorkflow).toMatch(/opened,\s*synchronize,\s*reopened,\s*ready_for_review/);
    expect(reviewWorkflow).toMatch(/workflow_dispatch:/);
    expect(reviewWorkflow).toMatch(
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/
    );
    expect(reviewWorkflow).toMatch(/github\.actor != 'dependabot\[bot\]'/);
    expect(reviewWorkflow).toMatch(/Fork and Dependabot PRs are excluded/);
  });

  it('pins the reviewer and artifact actions to immutable SHAs', () => {
    expect(reviewWorkflow).toContain(`concretios/ai-pr-reviewer@${V2_RELEASE_SHA} # v2.0.0`);
    expect(requestWorkflow).toContain(`concretios/ai-pr-reviewer@${V2_RELEASE_SHA} # v2.0.0`);
    expect(reviewWorkflow).not.toMatch(/uses:\s*concretios\/ai-pr-reviewer@v/);
    expect(requestWorkflow).not.toMatch(/uses:\s*concretios\/ai-pr-reviewer@v/);
    expect(reviewWorkflow).toContain(
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1'
    );
    expect(requestWorkflow).toContain(
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1'
    );
  });

  it('accepts only exact maintainer review commands on pull request comments', () => {
    expect(requestWorkflow).toMatch(/issue_comment:/);
    expect(requestWorkflow).toContain("github.event.comment.body == '@dr-concretio review'");
    expect(requestWorkflow).toContain("github.event.comment.body == '@dr-concretio extend'");
    expect(requestWorkflow).toMatch(/bot_name:\s*dr-concretio/);
  });

  it('keeps project review rules, including vibe-coding-rules, on the base revision', () => {
    expect(reviewConfig).toMatch(/rules_paths:/);
    expect(reviewConfig).toMatch(/-\s*AGENTS\.md/);
    expect(reviewConfig).toMatch(/-\s*vibe-coding-rules\//);
    expect(reviewConfig).not.toMatch(/publish:|review_mode:|gemini_api_key:/);
  });
});
