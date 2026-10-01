import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceJob, filterFindings, createDemoJob } from '../src/state.js';

test('demo job starts with a reviewable intent', () => {
  const job = createDemoJob();
  assert.equal(job.status, 'intent');
  assert.equal(job.target, 'IEEEtran');
  assert.equal(job.stage, 'Thinking');
  assert.equal(job.repairsUsed, 0);
});

test('job advances through bounded stages without exceeding three repairs', () => {
  let job = createDemoJob();
  job = advanceJob(job);
  assert.equal(job.stage, 'Converting');
  assert.equal(job.status, 'running');
  job = advanceJob(job);
  assert.equal(job.stage, 'Compiling');
  job = advanceJob(job);
  assert.equal(job.stage, 'Validating');
  job = advanceJob(job);
  assert.equal(job.stage, 'Repairing');
  job = advanceJob(job);
  assert.equal(job.stage, 'Ready');
  assert.equal(job.status, 'ready');
  assert.ok(job.repairsUsed <= 3);
});

test('finding filter is case-insensitive and supports all findings', () => {
  const findings = createDemoJob().findings;
  assert.equal(filterFindings(findings, 'all').length, findings.length);
  assert.equal(filterFindings(findings, 'error').length, 1);
  assert.equal(filterFindings(findings, 'warning').length, 2);
  assert.equal(filterFindings(findings, 'CITATION').length, 1);
});
