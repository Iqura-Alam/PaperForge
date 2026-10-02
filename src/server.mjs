import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import Busboy from 'busboy';
import {
  applyAgentProposal, askReasoning, buildLatex, chatWithAgent, compileLatex,
  extractDocx, rejectAgentProposal, repairLatex, validateAgentProposal,
  validateLatex, validateUpload, TEMPLATE_IDS,
} from './pipeline.mjs';
import { createZip } from './zip.mjs';

const root = path.resolve('.');
const jobsRoot = path.join(root, '.codex-local', 'jobs');
const jobs = new Map();
const sseSubscribers = new Map();
const requestWindows = new Map();
const SESSION_COOKIE = 'paperforge_session';
const SESSION_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const JSON_LIMIT = 64 * 1024;
const SOURCE_LIMIT = 2 * 1024 * 1024;
const MAX_CONCURRENT_JOBS = 5;
const MAX_REPAIRS = 3;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const activeJobCount = { value: 0 };

await mkdir(jobsRoot, { recursive: true });

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

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

function sourceHash(source) {
  return createHash('sha256').update(String(source ?? ''), 'utf8').digest('hex');
}

function parseCookies(req) {
  const result = {};
  for (const pair of String(req.headers.cookie ?? '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    result[pair.slice(0, separator).trim()] = decodeURIComponent(pair.slice(separator + 1).trim());
  }
  return result;
}

function sessionFor(req, res, create = false) {
  const current = parseCookies(req)[SESSION_COOKIE];
  if (current && SESSION_PATTERN.test(current)) return current;
  if (!create) return null;
  const sessionId = randomBytes(32).toString('base64url');
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('set-cookie', `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure}`);
  return sessionId;
}

function publicProposal(proposal) {
  if (!proposal) return undefined;
  return {
    id: proposal.id, type: proposal.type, baseRevision: proposal.baseRevision,
    rationale: proposal.rationale, confidence: proposal.confidence,
    approvalRequired: proposal.approvalRequired, status: proposal.status,
    createdAt: proposal.createdAt, appliedAt: proposal.appliedAt, rejectedAt: proposal.rejectedAt,
  };
}

function publicJob(job) {
  const doc = job.document;
  return {
    id: job.id, filename: job.filename, size: job.size, target: job.target,
    status: job.status, stage: job.stage, progress: job.progress,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    findings: job.findings ?? [], repairsUsed: job.repairsUsed ?? 0, repairLog: job.repairLog ?? [],
    reasoning: job.reasoning ? {
      provider: job.reasoning.provider, fallback: Boolean(job.reasoning.fallback), summary: job.reasoning.summary,
      safeFixes: job.reasoning.safeFixes ?? [], approvalRequired: job.reasoning.approvalRequired ?? [],
      remainingIssues: job.reasoning.remainingIssues ?? [],
    } : undefined,
    document: doc ? {
      figures: doc.figures, tables: doc.tables?.length ?? 0, references: doc.references,
      imageHeavy: doc.imageHeavy, authorInfo: doc.authorInfo,
      assets: (doc.assetManifest ?? []).map(({ id, filename, mimeType, bytes, supported }) => ({ id, filename, mimeType, bytes, supported })),
    } : undefined,
    compile: job.compile ? { ok: job.compile.ok, pdf: job.compile.pdf, timedOut: job.compile.timedOut, notFound: job.compile.notFound } : undefined,
    sourceRevision: job.sourceRevision ?? 0, sourceHash: job.sourceHash,
    proposals: (job.proposals ?? []).map(publicProposal),
    audit: (job.audit ?? []).map(({ source: _source, ...entry }) => entry),
    outputs: {
      source: Boolean(job.source),
      sourceZip: ['ready', 'error', 'rolled-back'].includes(job.status) && Boolean(job.source),
      pdf: Boolean(job.compile?.pdf), report: ['ready', 'error', 'rolled-back'].includes(job.status),
      changelog: ['ready', 'error', 'rolled-back'].includes(job.status),
    },
    error: job.error,
  };
}

function ownedJob(req, res, id) {
  const sessionId = sessionFor(req, res, false);
  if (!sessionId) { json(res, 401, { error: 'A PaperForge session is required.' }); return null; }
  const job = jobs.get(id);
  if (!job || job.ownerSessionId !== sessionId) { json(res, 404, { error: 'Job not found.' }); return null; }
  return job;
}

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const recent = (requestWindows.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
  if (recent.length >= limit) return false;
  recent.push(now); requestWindows.set(key, recent); return true;
}

function emitSSE(jobId, eventName, payload) {
  const subscribers = sseSubscribers.get(jobId);
  if (!subscribers) return;
  const chunk = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const response of subscribers) {
    try { response.write(chunk); } catch { subscribers.delete(response); }
  }
}

function pushJobUpdate(job) {
  job.updatedAt = new Date().toISOString();
  emitSSE(job.id, 'job', publicJob(job));
}

async function parseUpload(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let manuscriptFile = null;
    let bibFile = null;
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    let parser;
    try {
      parser = Busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024, files: 2, fields: 8, fieldSize: 8 * 1024 } });
    } catch {
      return reject(new RequestError(400, 'A multipart manuscript upload is required.'));
    }
    parser.on('field', (name, value) => { fields[name] = value; });
    parser.on('file', (name, stream, info) => {
      const chunks = [];
      let size = 0;
      let truncated = false;
      const fileData = { field: name, filename: safeName(info.filename), mimeType: info.mimeType, size: 0 };
      stream.on('data', (chunk) => { size += chunk.length; chunks.push(chunk); });
      stream.on('limit', () => { truncated = true; fail(new RequestError(413, 'File exceeds the 25 MB limit.')); });
      stream.on('end', () => {
        if (truncated) return;
        fileData.size = size; fileData.buffer = Buffer.concat(chunks);
        if (name === 'bibliography') bibFile = fileData;
        else if (name === 'manuscript') manuscriptFile = fileData;
      });
    });
    parser.on('filesLimit', () => fail(new RequestError(413, 'Upload contains too many files.')));
    parser.on('error', () => fail(new RequestError(400, 'Upload could not be parsed.')));
    parser.on('finish', () => {
      if (settled) return;
      settled = true;
      if (!manuscriptFile) reject(new RequestError(400, 'No manuscript file was uploaded.'));
      else resolve({ fields, file: manuscriptFile, bibFile });
    });
    req.pipe(parser);
  });
}

async function parseJsonBody(req, maxBytes = JSON_LIMIT) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) { tooLarge = true; return; }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return reject(new RequestError(413, `JSON body exceeds ${maxBytes} bytes.`));
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new RequestError(400, 'Invalid JSON body.')); }
    });
    req.on('error', () => reject(new RequestError(400, 'Request body could not be read.')));
  });
}

function reconcileCitations(source, bibContent) {
  if (!bibContent) return { source, bibKeys: [], unresolved: [] };
  const bibKeys = [...bibContent.matchAll(/@\w+\{\s*([^,\s]+)/g)].map((match) => match[1]);
  let patched = source;
  if (!patched.includes('\\bibliography{')) patched = patched.replace('\\end{document}', '\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}');
  const citeKeys = [...patched.matchAll(/\\cite\{([^}]+)\}/g)].flatMap((match) => match[1].split(',').map((key) => key.trim()));
  return { source: patched, bibKeys, unresolved: citeKeys.filter((key) => !bibKeys.includes(key)) };
}

function compilationFinding(job) {
  if (job.compile?.ok) return [];
  return [{
    severity: 'error', rule: 'compilation',
    title: job.compile?.timedOut ? 'Compilation timed out' : job.compile?.notFound ? 'Compiler unavailable' : 'Compilation failed',
    confidence: 1,
    detail: job.compile?.notFound
      ? 'The LaTeX source is ready, but this runtime has no compiler. Download the source package or retry in the deployed compiler service.'
      : 'Review the compiler log or use the source editor and agent proposals for a bounded correction.',
    approval: false, actions: ['edit-source', 'ask-agent', 'retry-compile'],
  }];
}

async function compileWithRepairs(job) {
  let source = job.source;
  let repairsUsed = 0;
  const repairLog = [];
  let compile;
  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    job.stage = attempt === 0 ? 'Compiling' : 'Repairing';
    job.progress = attempt === 0 ? 72 : 72 + attempt * 5;
    pushJobUpdate(job);
    compile = await compileLatex({ source, jobDir: job.dir, target: job.target });
    if (compile.ok || compile.notFound) break;
    if (attempt === MAX_REPAIRS) break;
    const repaired = repairLatex(source, compile.log);
    if (!repaired.repairs.length) break;
    source = repaired.source; repairsUsed += 1; repairLog.push(...repaired.repairs);
  }
  job.source = source; job.sourceHash = sourceHash(source); job.compile = compile;
  job.repairsUsed = repairsUsed; job.repairLog = [...(job.repairLog ?? []), ...repairLog];
  return compile;
}

function needsApproval(findings) {
  return findings.some((finding) => finding.approval && finding.severity !== 'pass');
}

async function waitForApproval(job) {
  return new Promise((resolve) => {
    job.status = 'awaiting-approval'; job.stage = 'Awaiting approval'; job.approvalResolve = resolve; pushJobUpdate(job);
  });
}

async function writeArtifacts(job) {
  await writeFile(path.join(job.dir, 'paper.tex'), job.source, 'utf8');
  await writeFile(path.join(job.dir, 'validation.json'), JSON.stringify({
    jobId: job.id, sourceRevision: job.sourceRevision, sourceHash: job.sourceHash,
    findings: job.findings,
    compile: job.compile ? { ok: job.compile.ok, pdf: job.compile.pdf, timedOut: job.compile.timedOut, notFound: job.compile.notFound } : undefined,
    reasoning: job.reasoning, repairs: job.repairLog ?? [], assets: job.document?.assetManifest ?? [], audit: job.audit ?? [],
  }, null, 2));
  const auditLines = (job.audit ?? []).map((entry) => `- ${entry.timestamp}: ${entry.actor} — ${entry.action}${entry.rationale ? ` (${entry.rationale})` : ''}`);
  const repairLines = (job.repairLog ?? []).map((repair) => `- Repair [${repair.rule}]: ${repair.description}`);
  await writeFile(path.join(job.dir, 'change-log.md'), [
    '# Change log', '', '- Generated editable LaTeX from DOCX structure.',
    '- Scientific text was not rewritten by automatic repairs.', ...repairLines, ...auditLines,
    `- ${job.findings.length} validation findings recorded.`, '',
  ].join('\n'), 'utf8');
}

async function finishSourceChange(job, { actor, action, rationale }) {
  job.status = 'running'; job.error = undefined; job.findings = validateLatex(job.source, job.document);
  await compileWithRepairs(job);
  job.findings = [...compilationFinding(job), ...validateLatex(job.source, job.document)];
  job.audit.push({ timestamp: new Date().toISOString(), actor, action, rationale, revision: job.sourceRevision, sourceHash: job.sourceHash });
  job.reasoning = await askReasoning({ findings: job.findings, document: job.document, jobId: job.id });
  job.stage = 'Ready'; job.progress = 100; job.status = 'ready';
  await writeArtifacts(job); pushJobUpdate(job);
}

async function processJob(job) {
  activeJobCount.value += 1;
  try {
    job.stage = 'Converting'; job.progress = 28; pushJobUpdate(job);
    job.document = await extractDocx(job.buffer, job.filename, job.dir);
    if (job.document.figures >= 10 && !job.imageHeavyConsent) {
      job.status = 'awaiting-image-consent'; job.stage = 'Awaiting consent';
      job.findings = [{ severity: 'warning', rule: 'image-heavy', title: `${job.document.figures} images detected — consent required`, confidence: 1, detail: 'Review image extraction before continuing.', approval: true, actions: ['consent'] }];
      pushJobUpdate(job); return;
    }
    job.stage = 'Validating'; job.progress = 55; pushJobUpdate(job);
    job.source = buildLatex(job.document, job.target);
    if (job.bibBuffer) {
      const bibContent = job.bibBuffer.toString('utf8');
      const reconciled = reconcileCitations(job.source, bibContent);
      job.source = reconciled.source; job.bibKeys = reconciled.bibKeys;
      await writeFile(path.join(job.dir, 'refs.bib'), bibContent, 'utf8');
      if (reconciled.unresolved.length) job.findings.push({ severity: 'warning', rule: 'citation-integrity', title: `${reconciled.unresolved.length} unresolved citation key(s)`, confidence: 0.95, detail: `Missing keys: ${reconciled.unresolved.slice(0, 5).join(', ')}.`, approval: false, actions: ['edit-source'] });
    }
    job.sourceOriginal = job.source; job.sourceRevision = 0; job.sourceHash = sourceHash(job.source);
    job.findings = [...job.findings, ...validateLatex(job.source, job.document)];
    if (needsApproval(job.findings)) { await waitForApproval(job); job.status = 'running'; }
    await compileWithRepairs(job);
    if (job.source !== job.sourceOriginal) {
      job.snapshots.push({ source: job.sourceOriginal, revision: 0, sourceHash: sourceHash(job.sourceOriginal), reason: 'pre-automatic-repair' });
      job.sourceRevision = 1; job.sourceHash = sourceHash(job.source);
    }
    await writeFile(path.join(job.dir, 'input.docx'), job.buffer);
    job.buffer = null; job.bibBuffer = null;
    job.findings = [...compilationFinding(job), ...job.findings];
    job.stage = 'Reasoning'; job.progress = 88; pushJobUpdate(job);
    job.reasoning = await askReasoning({ findings: job.findings, document: job.document, jobId: job.id });
    if (!job.chatHistory.length) job.chatHistory.push({
      role: 'assistant', content: `I've reviewed your document. ${job.reasoning.summary} Tell me what formatting you want to change; I will present any executable change for approval.`,
      provider: job.reasoning.provider, timestamp: new Date().toISOString(),
    });
    job.stage = 'Ready'; job.progress = 100; job.status = 'ready';
    await writeArtifacts(job); pushJobUpdate(job);
    const subscribers = sseSubscribers.get(job.id);
    if (subscribers) {
      for (const response of subscribers) { try { response.write('event: done\ndata: {}\n\n'); response.end(); } catch { /* ignore */ } }
      sseSubscribers.delete(job.id);
    }
  } catch (error) {
    job.status = 'error'; job.stage = 'Escalated'; job.progress = 100;
    job.error = error instanceof RequestError ? error.message : 'Conversion failed. Use the manual recovery tools or try another document.';
    if (!job.chatHistory.length) job.chatHistory.push({ role: 'assistant', content: job.error, provider: 'rule-based', timestamp: new Date().toISOString() });
    if (job.source) await writeArtifacts(job).catch(() => {});
    pushJobUpdate(job);
  } finally {
    activeJobCount.value = Math.max(0, activeJobCount.value - 1);
  }
}

async function readOptional(filename) {
  try { return await readFile(filename); } catch { return null; }
}

async function sourceZip(job) {
  const entries = [];
  for (const filename of ['paper.tex', 'refs.bib', 'validation.json', 'change-log.md', 'paper.pdf']) {
    const data = await readOptional(path.join(job.dir, filename));
    if (data) entries.push({ name: filename, data });
  }
  for (const asset of job.document?.assetManifest ?? []) {
    const data = await readOptional(path.join(job.dir, safeName(asset.filename)));
    if (data) entries.push({ name: `assets/${safeName(asset.filename)}`, data });
  }
  return createZip(entries);
}

async function runRetentionCleanup() {
  try {
    const now = Date.now();
    for (const entry of await readdir(jobsRoot)) {
      const directory = path.join(jobsRoot, entry);
      try {
        const info = await stat(directory);
        if (info.isDirectory() && now - info.mtimeMs > RETENTION_MS) {
          await rm(directory, { recursive: true, force: true }); jobs.delete(entry);
        }
      } catch { /* skip individual entries */ }
    }
  } catch { /* cleanup is best effort */ }
}

runRetentionCleanup();
setInterval(runRetentionCleanup, 6 * 60 * 60 * 1000).unref();

const server = http.createServer(async (req, res) => {
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  const url = new URL(req.url, 'http://paperforge.local');
  const pathname = url.pathname;
  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      const commit = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || '';
      return json(res, 200, { ok: true, service: 'paperforge', version: '0.4.0', revision: commit ? commit.slice(0, 12) : 'local', uptime: Math.floor(process.uptime()) });
    }
    if (pathname === '/api/jobs' && req.method === 'GET') {
      const sessionId = sessionFor(req, res, false);
      if (!sessionId) return json(res, 401, { error: 'A PaperForge session is required.' });
      return json(res, 200, [...jobs.values()].filter((job) => job.ownerSessionId === sessionId).map(publicJob));
    }
    if (pathname === '/api/jobs' && req.method === 'POST') {
      const sessionId = sessionFor(req, res, true);
      if (!rateLimit(`create:${sessionId}`, 10, 60 * 60 * 1000)) return json(res, 429, { error: 'Job creation limit reached. Try again later.' });
      if (activeJobCount.value >= MAX_CONCURRENT_JOBS) return json(res, 429, { error: 'Server is at capacity. Please retry shortly.' });
      const { fields, file, bibFile } = await parseUpload(req);
      validateUpload(file);
      const id = `PF-${randomUUID().toUpperCase()}`;
      const dir = path.join(jobsRoot, id);
      await mkdir(dir, { recursive: true });
      const now = new Date().toISOString();
      const job = {
        id, ownerSessionId: sessionId, filename: file.filename, size: file.size,
        target: TEMPLATE_IDS.includes(fields.target) ? fields.target : 'IEEEtran',
        status: 'running', stage: 'Thinking', progress: 8, dir,
        buffer: file.buffer, bibBuffer: bibFile?.buffer ?? null,
        imageHeavyConsent: fields.imageHeavyConsent === 'true', createdAt: now, updatedAt: now,
        findings: [], repairsUsed: 0, repairLog: [], chatHistory: [], proposals: [], audit: [], snapshots: [],
        sourceOriginal: null, sourceRevision: 0, sourceHash: null,
      };
      jobs.set(id, job); processJob(job);
      return json(res, 202, { job: publicJob(job) });
    }

    const match = pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      const job = ownedJob(req, res, match[1]);
      if (!job) return;
      const suffix = match[2] ?? '';
      if (req.method === 'GET' && !suffix) return json(res, 200, publicJob(job));
      if (req.method === 'GET' && suffix === 'events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write(`event: job\ndata: ${JSON.stringify(publicJob(job))}\n\n`);
        if (['ready', 'error', 'rolled-back', 'cancelled'].includes(job.status)) { res.write('event: done\ndata: {}\n\n'); return res.end(); }
        if (!sseSubscribers.has(job.id)) sseSubscribers.set(job.id, new Set());
        sseSubscribers.get(job.id).add(res); req.on('close', () => sseSubscribers.get(job.id)?.delete(res)); return;
      }
      if (req.method === 'GET' && suffix === 'diff') return json(res, 200, {
        jobId: job.id, original: job.sourceOriginal ?? job.source,
        repaired: job.sourceOriginal !== job.source ? job.source : null,
        hasChanges: job.sourceOriginal !== job.source, repairs: job.repairLog ?? [],
        sourceRevision: job.sourceRevision, sourceHash: job.sourceHash,
      });
      if (req.method === 'GET' && suffix === 'source') {
        if (!job.source) return json(res, 409, { error: 'Source is not ready.' });
        return json(res, 200, { source: job.source, revision: job.sourceRevision, sourceHash: job.sourceHash });
      }
      if (req.method === 'PUT' && suffix === 'source') {
        if (!['ready', 'error', 'rolled-back'].includes(job.status)) return json(res, 409, { error: 'Wait for conversion to finish before editing.' });
        const body = await parseJsonBody(req, SOURCE_LIMIT);
        const nextSource = String(body.source ?? '');
        if (Number(body.baseRevision) !== job.sourceRevision || (body.sourceHash && body.sourceHash !== job.sourceHash)) return json(res, 409, { error: 'Source revision conflict. Reload the latest source before saving.' });
        if (!nextSource.includes('\\begin{document}') || !nextSource.includes('\\end{document}')) return json(res, 422, { error: 'Source must contain a complete document environment.' });
        job.snapshots.push({ source: job.source, revision: job.sourceRevision, sourceHash: job.sourceHash, reason: 'before-manual-edit' });
        job.source = nextSource; job.sourceRevision += 1; job.sourceHash = sourceHash(nextSource);
        await finishSourceChange(job, { actor: 'user', action: 'manual-source-edit', rationale: String(body.rationale ?? 'Manual source edit').slice(0, 500) });
        return json(res, 200, { ok: true, job: publicJob(job) });
      }
      if (req.method === 'GET' && suffix === 'chat') return json(res, 200, { jobId: job.id, history: job.chatHistory, proposals: job.proposals.map(publicProposal) });
      if (req.method === 'POST' && suffix === 'chat') {
        const sessionId = sessionFor(req, res, false);
        if (!rateLimit(`chat:${sessionId}`, 30, 10 * 60 * 1000)) return json(res, 429, { error: 'Chat rate limit reached. Try again shortly.' });
        const body = await parseJsonBody(req);
        const message = String(body.message ?? '').trim();
        if (!message || message.length > 4_000) return json(res, 400, { error: 'message must contain 1–4000 characters.' });
        const userEntry = { role: 'user', content: message, timestamp: new Date().toISOString() };
        job.chatHistory.push(userEntry);
        const agentResponse = await chatWithAgent({
          jobId: job.id,
          messages: job.chatHistory.slice(-16).map(({ role, content }) => ({ role, content: String(content).slice(0, 4_000) })),
          job: {
            target: job.target, sourceRevision: job.sourceRevision, sourceHash: job.sourceHash,
            findings: job.findings.slice(0, 20),
            document: {
              authorInfo: job.document?.authorInfo,
              tables: job.document?.tables?.map((table, index) => ({ index: index + 1, caption: table.caption, rows: table.rows?.length, complex: table.complex })),
              assets: job.document?.assetManifest,
            },
            sourceExcerpt: String(job.source ?? '').slice(0, 20_000),
          },
        });
        let proposal;
        if (agentResponse.proposal) {
          try {
            proposal = validateAgentProposal({ ...agentResponse.proposal, id: `proposal-${randomUUID()}`, baseRevision: job.sourceRevision });
            proposal.createdAt = new Date().toISOString(); job.proposals.push(proposal);
          } catch { proposal = undefined; }
        }
        const assistantEntry = {
          role: 'assistant', content: String(agentResponse.message ?? 'I could not create a safe executable proposal. You can use the source editor for a manual change.'),
          provider: agentResponse.provider ?? 'rule-based', fallback: Boolean(agentResponse.fallback),
          proposalId: proposal?.id, timestamp: new Date().toISOString(),
        };
        job.chatHistory.push(assistantEntry); pushJobUpdate(job);
        return json(res, 200, { userEntry, assistantEntry, history: job.chatHistory, proposal: publicProposal(proposal) });
      }
      const proposalMatch = suffix.match(/^proposals\/([^/]+)\/(apply|reject)$/);
      if (req.method === 'POST' && proposalMatch) {
        const proposal = job.proposals.find((item) => item.id === proposalMatch[1]);
        if (!proposal) return json(res, 404, { error: 'Proposal not found.' });
        if (proposal.status !== 'pending') return json(res, 409, { error: `Proposal is already ${proposal.status}.` });
        const body = await parseJsonBody(req);
        if (proposalMatch[2] === 'reject') {
          Object.assign(proposal, rejectAgentProposal({ proposal, revision: job.sourceRevision }).proposal);
          job.audit.push({ timestamp: new Date().toISOString(), actor: 'user', action: 'reject-proposal', proposalId: proposal.id, revision: job.sourceRevision });
          pushJobUpdate(job); return json(res, 200, { ok: true, proposal: publicProposal(proposal), job: publicJob(job) });
        }
        if (proposal.approvalRequired && body.confirm !== true) return json(res, 422, { error: 'This proposal requires explicit confirmation.' });
        job.snapshots.push({ source: job.source, revision: job.sourceRevision, sourceHash: job.sourceHash, reason: `before-${proposal.id}` });
        let applied;
        try {
          applied = applyAgentProposal({ source: job.source, revision: job.sourceRevision, expectedRevision: Number(body.expectedRevision ?? proposal.baseRevision), proposal });
        } catch (error) {
          job.snapshots.pop(); return json(res, 409, { error: error.message });
        }
        job.source = applied.source; job.sourceRevision = applied.revision; job.sourceHash = sourceHash(job.source);
        Object.assign(proposal, applied.proposal);
        await finishSourceChange(job, { actor: 'agent-with-user-approval', action: 'apply-proposal', rationale: proposal.rationale });
        return json(res, 200, { ok: true, proposal: publicProposal(proposal), job: publicJob(job) });
      }
      const outputMatch = suffix.match(/^output\/(source|source-zip|report|changelog|pdf)$/);
      if (req.method === 'GET' && outputMatch) {
        const type = outputMatch[1];
        if (type === 'source-zip') {
          if (!job.source || !['ready', 'error', 'rolled-back'].includes(job.status)) return json(res, 409, { error: 'Source package is not ready.' });
          const archive = await sourceZip(job);
          res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="paperforge-${job.id}.zip"`, 'content-length': archive.length, 'cache-control': 'no-store' });
          return res.end(archive);
        }
        const files = { source: 'paper.tex', report: 'validation.json', changelog: 'change-log.md', pdf: 'paper.pdf' };
        const filename = files[type];
        const content = await readOptional(path.join(job.dir, filename));
        if (!content) return json(res, 404, { error: 'Output is not available.' });
        res.writeHead(200, { 'content-type': type === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store' });
        return res.end(content);
      }
      if (req.method === 'POST' && suffix === 'approve') {
        if (job.status !== 'awaiting-approval') return json(res, 409, { error: 'Job is not awaiting approval.' });
        if (typeof job.approvalResolve === 'function') { job.approvalResolve(); delete job.approvalResolve; }
        return json(res, 200, { ok: true, message: 'Approval recorded.' });
      }
      if (req.method === 'POST' && suffix === 'consent') {
        if (job.status !== 'awaiting-image-consent') return json(res, 409, { error: 'Job is not awaiting image consent.' });
        job.imageHeavyConsent = true; job.status = 'running'; processJob(job);
        return json(res, 200, { ok: true, message: 'Consent recorded.' });
      }
      if (req.method === 'POST' && suffix === 'rollback') {
        const snapshot = job.snapshots.pop();
        if (!snapshot) return json(res, 409, { error: 'No earlier source revision is available.' });
        job.source = snapshot.source; job.sourceRevision += 1; job.sourceHash = sourceHash(job.source);
        await finishSourceChange(job, { actor: 'user', action: 'rollback', rationale: snapshot.reason });
        job.status = 'rolled-back'; job.stage = 'Rolled back'; pushJobUpdate(job);
        return json(res, 200, { ok: true, message: 'Previous source revision restored.', job: publicJob(job) });
      }
      if (req.method === 'DELETE' && !suffix) {
        if (typeof job.approvalResolve === 'function') { job.approvalResolve(); delete job.approvalResolve; }
        job.status = 'cancelled'; pushJobUpdate(job); jobs.delete(job.id);
        await rm(job.dir, { recursive: true, force: true });
        const subscribers = sseSubscribers.get(job.id);
        if (subscribers) { for (const response of subscribers) { try { response.end(); } catch { /* ignore */ } } }
        sseSubscribers.delete(job.id);
        return json(res, 200, { ok: true, message: 'Job and artifacts deleted.' });
      }
      return json(res, 405, { error: 'Method not allowed.' });
    }
    if (req.method === 'GET') {
      const staticFiles = new Map([
        ['/', 'index.html'], ['/index.html', 'index.html'], ['/styles.css', 'styles.css'],
        ['/src/app.js', 'src/app.js'], ['/src/state.js', 'src/state.js'],
      ]);
      const relative = staticFiles.get(pathname);
      if (!relative) return res.writeHead(404).end();
      const file = path.join(root, relative);
      const content = await readFile(file);
      const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
      res.writeHead(200, {
        'content-type': `${type}; charset=utf-8`,
        'content-security-policy': "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        'cache-control': type === 'text/html' ? 'no-cache' : 'public, max-age=3600',
      });
      return res.end(content);
    }
    return json(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 400;
    return json(res, status, { error: error instanceof RequestError ? error.message : 'Request failed.' });
  }
});

const port = Number(process.env.PORT || 4174);
server.listen(port, '0.0.0.0', () => console.log(`PaperForge backend on http://0.0.0.0:${port}`));
