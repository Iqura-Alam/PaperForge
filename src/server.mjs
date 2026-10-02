import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import Busboy from 'busboy';
import {
  askReasoning, buildLatex, compileLatex, extractDocx,
  repairLatex, validateLatex, validateUpload, chatWithAgent, LIMITS, TEMPLATE_IDS,
} from './pipeline.mjs';

const root = path.resolve('.');
const jobsRoot = path.join(root, '.codex-local', 'jobs');
const jobs = new Map();

// SSE subscriber registry: jobId -> Set<response>
const sseSubscribers = new Map();

await mkdir(jobsRoot, { recursive: true });

// ---------------------------------------------------------------------------
// Concurrency / rate limiting
// ---------------------------------------------------------------------------
const MAX_CONCURRENT_JOBS = 5;
const activeJobCount = { value: 0 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

function safeName(value) {
  return path.basename(value ?? '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'unnamed';
}

function publicJob(job) {
  const { buffer, bibBuffer, document: doc, source, dir, approvalResolve, ...safe } = job;
  return {
    ...safe,
    document: doc
      ? {
          figures: doc.figures,
          tables: doc.tables.length,
          references: doc.references,
          imageHeavy: doc.imageHeavy,
          authorInfo: doc.authorInfo,
          imageMap: doc.imageMap,
        }
      : undefined,
    compile: job.compile
      ? { ok: job.compile.ok, pdf: job.compile.pdf, timedOut: job.compile.timedOut }
      : undefined,
  };
}

function emitSSE(jobId, eventName, payload) {
  const subs = sseSubscribers.get(jobId);
  if (!subs || subs.size === 0) return;
  const chunk = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of subs) {
    try { res.write(chunk); } catch { subs.delete(res); }
  }
}

function pushJobUpdate(job) {
  emitSSE(job.id, 'job', publicJob(job));
}

// ---------------------------------------------------------------------------
// Multipart upload parser
// ---------------------------------------------------------------------------
async function parseUpload(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let manuscriptFile = null;
    let bibFile = null;
    const parser = Busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024, files: 2, fields: 5 } });

    parser.on('field', (name, value) => { fields[name] = value; });
    parser.on('file', (name, stream, info) => {
      const chunks = [];
      let size = 0;
      const fileData = { field: name, filename: safeName(info.filename), mimeType: info.mimeType, size: 0 };
      stream.on('data', (chunk) => { size += chunk.length; chunks.push(chunk); });
      stream.on('limit', () => reject(new Error('File exceeds the 25 MB limit.')));
      stream.on('end', () => {
        fileData.size = size;
        fileData.buffer = Buffer.concat(chunks);
        if (name === 'bibliography') { bibFile = fileData; } else { manuscriptFile = fileData; }
      });
    });
    parser.on('error', reject);
    parser.on('finish', () => manuscriptFile
      ? resolve({ fields, file: manuscriptFile, bibFile })
      : reject(new Error('No manuscript file was uploaded.')));
    req.pipe(parser);
  });
}

// ---------------------------------------------------------------------------
// Parse JSON body
// ---------------------------------------------------------------------------
async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON body.')); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Bibliography citation-key reconciliation
// ---------------------------------------------------------------------------
function reconcileCitations(source, bibContent) {
  if (!bibContent) return { source, bibKeys: [], unresolved: [] };
  const bibKeys = [...bibContent.matchAll(/@\w+\{\s*([^,\s]+)/g)].map((m) => m[1]);
  let patched = source;
  if (!patched.includes('\\bibliography{')) {
    patched = patched.replace('\\end{document}', '\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}');
  }
  const citeKeys = [...patched.matchAll(/\\cite\{([^}]+)\}/g)].flatMap((m) => m[1].split(',').map((k) => k.trim()));
  const unresolved = citeKeys.filter((k) => !bibKeys.includes(k));
  return { source: patched, bibKeys, unresolved };
}

// ---------------------------------------------------------------------------
// Image-heavy detection
// ---------------------------------------------------------------------------
const IMAGE_HEAVY_THRESHOLD = 10;
function isImageHeavy(doc) { return doc.figures >= IMAGE_HEAVY_THRESHOLD; }

// ---------------------------------------------------------------------------
// Bounded repair loop (3 attempts max)
// ---------------------------------------------------------------------------
const MAX_REPAIRS = 3;

async function compileWithRepairs(job) {
  let source = job.source;
  let repairsUsed = 0;
  let compile;
  const repairLog = [];

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    job.stage = attempt === 0 ? 'Compiling' : 'Repairing';
    job.progress = attempt === 0 ? 72 : 72 + attempt * 5;
    job.repairsUsed = repairsUsed;
    pushJobUpdate(job);

    compile = await compileLatex({ source, jobDir: job.dir, target: job.target });

    if (compile.ok) break;
    if (attempt === MAX_REPAIRS) {
      job.findings.unshift({
        severity: 'error', rule: 'repair-budget-exhausted',
        title: `Compilation failed after ${MAX_REPAIRS} repair attempt(s)`,
        confidence: 1,
        detail: 'Automatic repair budget is exhausted. Use the chat below to ask the agent for help or download the LaTeX source for manual review.',
        approval: false,
      });
      break;
    }

    const { source: repairedSource, repairs } = repairLatex(source, compile.log);
    if (repairs.length === 0) break;
    source = repairedSource;
    repairsUsed += 1;
    repairLog.push(...repairs);
  }

  job.source = source;
  job.compile = compile;
  job.repairsUsed = repairsUsed;
  job.repairLog = repairLog;
  return compile;
}

// ---------------------------------------------------------------------------
// Human approval gate
// ---------------------------------------------------------------------------
function needsApproval(findings) {
  return findings.some((f) => f.approval && f.severity !== 'pass');
}

async function waitForApproval(job) {
  return new Promise((resolve) => {
    job.status = 'awaiting-approval';
    job.stage = 'Awaiting approval';
    job.approvalResolve = resolve;
    pushJobUpdate(job);
  });
}

// ---------------------------------------------------------------------------
// Core job processor
// ---------------------------------------------------------------------------
async function processJob(job) {
  activeJobCount.value += 1;
  try {
    // Extract — pass jobDir so images can be saved
    job.stage = 'Converting'; job.progress = 28;
    pushJobUpdate(job);
    job.document = await extractDocx(job.buffer, job.filename, job.dir);

    // Image-heavy consent gate
    if (isImageHeavy(job.document) && !job.imageHeavyConsent) {
      job.status = 'awaiting-image-consent';
      job.stage = 'Awaiting consent';
      job.findings = [{
        severity: 'warning', rule: 'image-heavy',
        title: `${job.document.figures} images detected — consent required`,
        confidence: 1,
        detail: 'This document is image-heavy. Extraction will proceed but image assets may require manual verification. Send POST /api/jobs/:id/consent to continue.',
        approval: true,
      }];
      pushJobUpdate(job);
      activeJobCount.value -= 1;
      return; // suspended — resumed by /consent
    }

    // Build LaTeX
    job.stage = 'Validating'; job.progress = 55;
    pushJobUpdate(job);
    job.source = buildLatex(job.document, job.target);
    job.sourceOriginal = job.source; // snapshot for rollback / diff

    // Bibliography reconciliation
    if (job.bibBuffer) {
      const bibContent = job.bibBuffer.toString('utf8');
      const { source, bibKeys, unresolved } = reconcileCitations(job.source, bibContent);
      job.source = source;
      job.bibKeys = bibKeys;
      if (unresolved.length > 0) {
        job.findings.push({
          severity: 'warning', rule: 'citation-integrity',
          title: `${unresolved.length} unresolved citation key(s)`,
          confidence: 0.95,
          detail: `Keys not found in provided bibliography: ${unresolved.slice(0, 5).join(', ')}${unresolved.length > 5 ? ` … and ${unresolved.length - 5} more` : ''}.`,
          approval: false,
        });
      }
      job.findings.push({
        severity: 'pass', rule: 'bibliography-loaded',
        title: `Bibliography loaded: ${bibKeys.length} key(s)`,
        confidence: 1,
        detail: `The provided .bib file was parsed and ${bibKeys.length} citation key(s) were registered.`,
        approval: false,
      });
      await writeFile(path.join(job.dir, 'refs.bib'), bibContent, 'utf8');
    }

    job.findings = [...job.findings, ...validateLatex(job.source, job.document)];
    pushJobUpdate(job);

    // Approval gate before compile
    if (needsApproval(job.findings)) {
      await waitForApproval(job);
      job.status = 'running';
      pushJobUpdate(job);
    }

    // Bounded repair loop
    await compileWithRepairs(job);
    await writeFile(path.join(job.dir, 'input.docx'), job.buffer);

    if (!job.compile.ok) {
      job.findings.unshift({
        severity: 'error', rule: 'compilation',
        title: job.compile.timedOut ? 'Compilation timed out' : 'Compilation failed',
        confidence: 1,
        detail: 'Review compiler log and generated source. Use the agent chat to ask for help with specific errors.',
        approval: false,
      });
    }

    // Reasoning agent
    job.stage = 'Reasoning'; job.progress = 88;
    pushJobUpdate(job);
    job.reasoning = await askReasoning({ findings: job.findings, document: job.document, jobId: job.id });

    // Initialise chat history
    if (!job.chatHistory) {
      job.chatHistory = [{
        role: 'assistant',
        content: job.reasoning?.summary
          ? `I've reviewed your document. ${job.reasoning.summary} How can I help you refine the output?`
          : 'Your document has been converted. How can I help you refine the output?',
        timestamp: new Date().toISOString(),
      }];
    }

    // Finalise
    job.stage = 'Ready'; job.progress = 100; job.status = 'ready';
    await writeFile(path.join(job.dir, 'paper.tex'), job.source, 'utf8');
    if (job.sourceOriginal && job.sourceOriginal !== job.source) {
      await writeFile(path.join(job.dir, 'paper.original.tex'), job.sourceOriginal, 'utf8');
    }
    await writeFile(path.join(job.dir, 'validation.json'), JSON.stringify({
      jobId: job.id, findings: job.findings, compile: job.compile,
      reasoning: job.reasoning, repairs: job.repairLog ?? [],
    }, null, 2));
    await writeFile(path.join(job.dir, 'change-log.md'),
      `# Change log\n\n` +
      `- Generated editable LaTeX from DOCX structure.\n` +
      `- Applied no semantic rewrites.\n` +
      (job.repairLog?.length ? job.repairLog.map((r) => `- Repair [${r.rule}]: ${r.description}`).join('\n') + '\n' : '') +
      `- ${job.findings.length} validation findings recorded.\n`
    );
    pushJobUpdate(job);
    // Close SSE subscribers after job completes
    const subs = sseSubscribers.get(job.id);
    if (subs) { for (const res of subs) { try { res.write('event: done\ndata: {}\n\n'); res.end(); } catch { /* ignore */ } } sseSubscribers.delete(job.id); }
  } catch (error) {
    job.status = 'error'; job.stage = 'Escalated';
    job.error = error.message; job.progress = 100;
    // Still init chat history so user can ask about the error
    if (!job.chatHistory) {
      job.chatHistory = [{
        role: 'assistant',
        content: `An error occurred during conversion: ${error.message}. I can help you understand what went wrong or suggest next steps.`,
        timestamp: new Date().toISOString(),
      }];
    }
    pushJobUpdate(job);
    const subs = sseSubscribers.get(job.id);
    if (subs) { for (const res of subs) { try { res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`); res.end(); } catch { /* ignore */ } } sseSubscribers.delete(job.id); }
  } finally {
    activeJobCount.value = Math.max(0, activeJobCount.value - 1);
  }
}

// ---------------------------------------------------------------------------
// Retention cleanup worker (24-hour)
// ---------------------------------------------------------------------------
const RETENTION_MS = 24 * 60 * 60 * 1000;

async function runRetentionCleanup() {
  try {
    const entries = await readdir(jobsRoot);
    const now = Date.now();
    for (const entry of entries) {
      const dirPath = path.join(jobsRoot, entry);
      try {
        const info = await stat(dirPath);
        if (info.isDirectory() && now - info.mtimeMs > RETENTION_MS) {
          await rm(dirPath, { recursive: true, force: true });
          jobs.delete(entry);
        }
      } catch { /* skip */ }
    }
  } catch { /* non-fatal */ }
}

runRetentionCleanup();
setInterval(runRetentionCleanup, 6 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // Security headers for all responses
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('x-content-type-options', 'nosniff');

  try {
    // Health
    if (req.method === 'GET' && req.url === '/api/health') {
      return json(res, 200, {
        ok: true, service: 'paperforge', version: '0.3.0',
        jobs: jobs.size, activeJobs: activeJobCount.value,
        uptime: process.uptime(),
        gemini: Boolean(process.env.GEMINI_API_KEY),
      });
    }

    // GET /api/jobs — list all jobs (lightweight)
    if (req.method === 'GET' && req.url === '/api/jobs') {
      const list = [...jobs.values()].map(publicJob);
      return json(res, 200, list);
    }

    // POST /api/jobs — create job
    if (req.method === 'POST' && req.url === '/api/jobs') {
      if (activeJobCount.value >= MAX_CONCURRENT_JOBS) {
        return json(res, 429, { error: `Server is at capacity (${MAX_CONCURRENT_JOBS} active jobs). Please retry shortly.` });
      }
      const { fields, file, bibFile } = await parseUpload(req);
      validateUpload(file);
      const id = `PF-${randomUUID().slice(0, 8).toUpperCase()}`;
      const dir = path.join(jobsRoot, id);
      await mkdir(dir, { recursive: true });
      const job = {
        id, filename: file.filename, size: file.size,
        target: TEMPLATE_IDS.includes(fields.target) ? fields.target : 'IEEEtran',
        status: 'running', stage: 'Thinking', progress: 8,
        dir, buffer: file.buffer,
        bibBuffer: bibFile?.buffer ?? null,
        imageHeavyConsent: fields.imageHeavyConsent === 'true',
        createdAt: new Date().toISOString(),
        findings: [], repairsUsed: 0, repairLog: [],
        sourceOriginal: null,
        chatHistory: [],
      };
      jobs.set(id, job);
      processJob(job); // fire-and-forget
      return json(res, 202, publicJob(job));
    }

    // GET /api/jobs/:id/events — SSE stream for real-time progress
    const matchEvents = req.url.match(/^\/api\/jobs\/([^/]+)\/events$/);
    if (req.method === 'GET' && matchEvents) {
      const job = jobs.get(matchEvents[1]);
      if (!job) return json(res, 404, { error: 'Job not found.' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`event: job\ndata: ${JSON.stringify(publicJob(job))}\n\n`);
      if (!sseSubscribers.has(job.id)) sseSubscribers.set(job.id, new Set());
      sseSubscribers.get(job.id).add(res);
      req.on('close', () => { const subs = sseSubscribers.get(job.id); if (subs) subs.delete(res); });
      return; // keep-alive; don't end
    }

    // GET /api/jobs/:id/diff — before/after LaTeX diff
    const matchDiff = req.url.match(/^\/api\/jobs\/([^/]+)\/diff$/);
    if (req.method === 'GET' && matchDiff) {
      const job = jobs.get(matchDiff[1]);
      if (!job) return json(res, 404, { error: 'Job not found.' });
      if (!job.source) return json(res, 409, { error: 'LaTeX source not yet generated.' });
      const original = job.sourceOriginal ?? job.source;
      const current = job.source;
      return json(res, 200, {
        jobId: job.id, original,
        repaired: original !== current ? current : null,
        hasChanges: original !== current,
        repairs: job.repairLog ?? [],
      });
    }

    // GET /api/jobs/:id/chat — get chat history
    const matchChatGet = req.url.match(/^\/api\/jobs\/([^/]+)\/chat$/);
    if (req.method === 'GET' && matchChatGet) {
      const job = jobs.get(matchChatGet[1]);
      if (!job) return json(res, 404, { error: 'Job not found.' });
      return json(res, 200, { jobId: job.id, history: job.chatHistory ?? [] });
    }

    // POST /api/jobs/:id/chat — send a chat message
    const matchChatPost = req.url.match(/^\/api\/jobs\/([^/]+)\/chat$/);
    if (req.method === 'POST' && matchChatPost) {
      const job = jobs.get(matchChatPost[1]);
      if (!job) return json(res, 404, { error: 'Job not found.' });

      let body;
      try { body = await parseJsonBody(req); } catch { return json(res, 400, { error: 'Invalid JSON body.' }); }

      const userMessage = String(body.message ?? '').trim();
      if (!userMessage) return json(res, 400, { error: 'message is required.' });

      if (!job.chatHistory) job.chatHistory = [];

      // Add user message to history
      const userEntry = { role: 'user', content: userMessage, timestamp: new Date().toISOString() };
      job.chatHistory.push(userEntry);

      // Build messages array for AI (last N turns to keep context bounded)
      const contextMessages = job.chatHistory.slice(-20).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      // Call agent
      const agentResponse = await chatWithAgent({
        jobId: job.id,
        messages: contextMessages,
        job,
      });

      const assistantEntry = {
        role: 'assistant',
        content: agentResponse.message ?? agentResponse.summary ?? JSON.stringify(agentResponse),
        action: agentResponse.action,
        patch: agentResponse.patch,
        timestamp: new Date().toISOString(),
      };
      job.chatHistory.push(assistantEntry);

      // If agent suggested a patch, emit SSE update
      pushJobUpdate(job);

      return json(res, 200, { userEntry, assistantEntry, history: job.chatHistory });
    }

    // GET /api/jobs/:id[/output/:type]
    const matchJob = req.url.match(/^\/api\/jobs\/([^/]+)(?:\/output\/([^/]+))?$/);
    if (req.method === 'GET' && matchJob) {
      const job = jobs.get(matchJob[1]);
      if (!job) return json(res, 404, { error: 'Job not found.' });
      if (!matchJob[2]) return json(res, 200, publicJob(job));
      const allowed = { source: 'paper.tex', report: 'validation.json', changelog: 'change-log.md', pdf: 'paper.pdf' };
      const filename = allowed[matchJob[2]];
      if (!filename) return json(res, 404, { error: 'Output not found.' });
      const content = await readFile(path.join(job.dir, filename));
      res.writeHead(200, {
        'content-type': filename.endsWith('.pdf') ? 'application/pdf' : 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
      });
      return res.end(content);
    }

    // POST /api/jobs/:id/approve — resume after approval gate
    const matchApprove = req.url.match(/^\/api\/jobs\/([^/]+)\/approve$/);
    if (req.method === 'POST' && matchApprove) {
      const job = jobs.get(matchApprove[1]);
      if (!job) return json(res, 404, { error: 'Job not found.' });
      if (job.status !== 'awaiting-approval') return json(res, 409, { error: 'Job is not awaiting approval.' });
      if (typeof job.approvalResolve === 'function') { job.approvalResolve(); delete job.approvalResolve; }
      return json(res, 200, { ok: true, message: 'Approval recorded. Conversion resuming.' });
    }

    // POST /api/jobs/:id/consent — resume after image-heavy consent
    const matchConsent = req.url.match(/^\/api\/jobs\/([^/]+)\/consent$/);
    if (req.method === 'POST' && matchConsent) {
      const job = jobs.get(matchConsent[1]);
      if (!job) return json(res, 404, { error: 'Job not found.' });
      if (job.status !== 'awaiting-image-consent') return json(res, 409, { error: 'Job is not awaiting image consent.' });
      job.imageHeavyConsent = true;
      job.status = 'running';
      processJob(job); // resume
      return json(res, 200, { ok: true, message: 'Consent recorded. Extraction resuming.' });
    }

    // POST /api/jobs/:id/rollback — restore original LaTeX before repairs
    const matchRollback = req.url.match(/^\/api\/jobs\/([^/]+)\/rollback$/);
    if (req.method === 'POST' && matchRollback) {
      const job = jobs.get(matchRollback[1]);
      if (!job) return json(res, 404, { error: 'Job not found.' });
      if (!['ready', 'error'].includes(job.status)) return json(res, 409, { error: 'Job must be completed before rollback.' });
      if (!job.sourceOriginal || job.sourceOriginal === job.source) return json(res, 409, { error: 'No repairs to roll back.' });
      job.source = job.sourceOriginal;
      job.repairLog = [];
      job.repairsUsed = 0;
      await writeFile(path.join(job.dir, 'paper.tex'), job.source, 'utf8');
      job.status = 'rolled-back';
      job.stage = 'Rolled back';
      pushJobUpdate(job);
      return json(res, 200, { ok: true, message: 'Source rolled back to pre-repair state. Download the updated LaTeX source.' });
    }

    // DELETE /api/jobs/:id — cancel/delete job
    const matchDelete = req.url.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === 'DELETE' && matchDelete) {
      const job = jobs.get(matchDelete[1]);
      if (!job) return json(res, 404, { error: 'Job not found.' });
      if (typeof job.approvalResolve === 'function') { job.approvalResolve(); delete job.approvalResolve; }
      job.status = 'cancelled'; job.stage = 'Cancelled'; job.progress = 0;
      pushJobUpdate(job);
      jobs.delete(job.id);
      rm(job.dir, { recursive: true, force: true }).catch(() => {});
      const subs = sseSubscribers.get(job.id);
      if (subs) { for (const r of subs) { try { r.write('event: cancelled\ndata: {}\n\n'); r.end(); } catch { /* ignore */ } } sseSubscribers.delete(job.id); }
      return json(res, 200, { ok: true, message: 'Job cancelled and artifacts deleted.' });
    }

    // Static file serving
    if (req.method === 'GET') {
      const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
      const file = path.resolve(root, `.${requested}`);
      if (!file.startsWith(root) || file.includes('node_modules') || file.includes('.codex-local')) {
        return res.writeHead(403).end();
      }
      let content;
      try { content = await readFile(file); } catch { return res.writeHead(404).end(); }
      const type = file.endsWith('.css') ? 'text/css'
        : file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript'
        : 'text/html';
      res.writeHead(200, {
        'content-type': `${type}; charset=utf-8`,
        'content-security-policy': "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        'cache-control': type === 'text/html' ? 'no-cache' : 'public, max-age=3600',
      });
      return res.end(content);
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    return json(res, 400, { error: error.message || 'Request failed.' });
  }
});

const port = Number(process.env.PORT || 4174);
server.listen(port, '0.0.0.0', () => console.log(`PaperForge backend on http://0.0.0.0:${port}`));
