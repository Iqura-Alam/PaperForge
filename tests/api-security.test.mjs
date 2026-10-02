import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { createFixtureJob, startTestServer, waitForTerminalJob } from './helpers/test-server.mjs';

let server;
let created;

before(async () => {
  server = await startTestServer();
  created = await createFixtureJob(server.baseUrl);
});

after(async () => {
  await server?.stop();
});

test('job creation returns a per-session capability', () => {
  assert.equal(created.response.status, 202);
  assert.ok(created.capability || created.cookie, 'Job creation must establish a per-session capability');
});

test('the public job DTO does not leak private job state', () => {
  for (const forbidden of [
    'buffer', 'bibBuffer', 'dir', 'source', 'sourceOriginal',
    'approvalResolve', 'chatHistory',
  ]) {
    assert.equal(Object.hasOwn(created.job, forbidden), false, `Public DTO leaked ${forbidden}`);
  }
});

test('the unauthenticated public job index is disabled', async () => {
  const response = await fetch(`${server.baseUrl}/api/jobs`);
  assert.ok([401, 403, 404, 405].includes(response.status), `Expected protected/removed index, received ${response.status}`);
});

test('job reads require the matching per-session capability', async () => {
  const anonymous = await fetch(`${server.baseUrl}/api/jobs/${created.job.id}`);
  assert.ok([401, 403, 404].includes(anonymous.status), `Anonymous read unexpectedly returned ${anonymous.status}`);

  assert.ok(created.capability || created.cookie, 'No capability was issued for the authorized read');
  const authorized = await fetch(`${server.baseUrl}/api/jobs/${created.job.id}`, { headers: created.accessHeaders });
  assert.equal(authorized.status, 200);
});

test('source ZIP contains the complete editable package', async () => {
  await waitForTerminalJob(server.baseUrl, created.job.id, created.accessHeaders);

  const response = await fetch(`${server.baseUrl}/api/jobs/${created.job.id}/output/source-zip`, {
    headers: created.accessHeaders,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/zip/);
  const archive = Buffer.from(await response.arrayBuffer());
  for (const requiredName of ['paper.tex', 'validation.json', 'change-log.md']) {
    assert.equal(archive.includes(Buffer.from(requiredName)), true, `Source ZIP missing ${requiredName}`);
  }
});
