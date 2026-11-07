import process from 'node:process';

import { runFeedbackPerformanceHarness } from './harness.mjs';
import { evaluateFeedbackPerformanceReport } from './verification.mjs';

const report = await runFeedbackPerformanceHarness();
const evaluation = evaluateFeedbackPerformanceReport(report);

process.stdout.write(`${JSON.stringify({ report, evaluation }, null, 2)}\n`);
if (!evaluation.passed) process.exitCode = 1;
