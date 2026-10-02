import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve('.');

async function reservePort() {
  const socket = net.createServer();
  socket.unref();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

export async function startTestServer() {
  const port = await reservePort();
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      GEMINI_API_KEY: '',
      OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  let startupTimer;
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (chunk.includes('PaperForge backend')) resolve();
      });
      child.once('exit', (code) => reject(new Error(`Test server exited early (${code}): ${stderr}`)));
      }),
      new Promise((_, reject) => {
        startupTimer = setTimeout(() => reject(new Error(`Timed out starting test server: ${stderr}`)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(startupTimer);
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill();
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    },
  };
}

export async function createFixtureJob(baseUrl) {
  const fixture = await readFile(path.join(repoRoot, 'tests', 'fixtures', 'minimal.docx'));
  const form = new FormData();
  form.append('manuscript', new Blob([fixture], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }), 'minimal.docx');
  form.append('target', 'IEEEtran');

  const response = await fetch(`${baseUrl}/api/jobs`, { method: 'POST', body: form });
  const payload = await response.json();
  const job = payload.job ?? payload;
  const capability = payload.capability ?? payload.accessToken ?? response.headers.get('x-job-capability');
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  const accessHeaders = capability
    ? { authorization: `Bearer ${capability}` }
    : cookie
      ? { cookie }
      : {};

  return { response, payload, job, capability, cookie, accessHeaders };
}

export async function waitForTerminalJob(baseUrl, jobId, accessHeaders, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastPayload;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/jobs/${jobId}`, { headers: accessHeaders });
    if (response.ok) {
      lastPayload = await response.json();
      if (['ready', 'error', 'rolled-back'].includes(lastPayload.status)) return lastPayload;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Job ${jobId} did not reach a terminal state: ${JSON.stringify(lastPayload)}`);
}
