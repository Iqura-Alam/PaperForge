import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import Busboy from 'busboy';
import {
  askReasoning, buildLatex, compileLatex, extractDocx,
  repairLatex, validateLatex, validateUpload, LIMITS,
} from './pipeline.mjs';

const root = path.resolve('.');
const jobsRoot = path.join(root, '.codex-local', 'jobs');
const jobs = new Map();
await mkdir(jobsRoot, { recursive: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function safeName(value) {
  return path.basename(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function publicJob(job) {
  const { buffer, bibBuffer, document, source, dir, approvalResolve, ...safe } = job;
  return {
    ...safe,
    document: document
      ? { figures: document.figures, tables: document.tables.length, references: document.references, imageHeavy: document.imageHeavy }
      : undefined,
    compile: job.compile ? { ok: job.compile.ok, pdf: job.compile.pdf, timedOut: job.compile.timedOut } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Multipart upload parser — supports both manuscript + optional .bib file
// ---------------------------------------------------------------------------
async function parseUpload(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let manuscriptFile = null;
    let bibFile = null;
    const parser = Busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024, files: 2, fields: 4 } });

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
// T019 — Bibliography citation-key reconciliation
// ---------------------------------------------------------------------------
function reconcileCitations(source, bibContent) {
  if (!bibContent) return { source, bibKeys: [], unresolved: [] };

  // Extract all @type{key, ... } keys from the .bib content
  const bibKeys = [...bibContent.matchAll(/@\w+\{\s*([^,\s]+)/g)].map((m) => m[1]);

  // Write \bibliography{refs} before \end{document} if not already present
  let patched = source;
  if (!patched.includes('\\bibliography{')) {
    patched = patched.replace('\\end{document}', '\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}');
  }

  // Detect \cite{key} references that have no matching bib key
  const citeKeys = [...patched.matchAll(/\\cite\{([^}]+)\}/g)].flatMap((m) => m[1].split(',').map((k) => k.trim()));
  const unresolved = citeKeys.filter((k) => !bibKeys.includes(k));

  return { source: patched, bibKeys, unresolved };
}

// ---------------------------------------------------------------------------
// T021 — Image-heavy detection (>10 images without explicit consent)
// ---------------------------------------------------------------------------
const IMAGE_HEAVY_THRESHOLD = 10;

function isImageHeavy(document) {
  return document.figures >= IMAGE_HEAVY_THRESHOLD;
}

// ---------------------------------------------------------------------------
// T016 — Bounded repair loop (3 attempts max, rule-based only)
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

    compile = await compileLatex({ source, jobDir: job.dir, target: job.target });

    if (compile.ok) break; // success — stop
    if (attempt === MAX_REPAIRS) {
      // Budget exhausted — escalate
      job.findings.unshift({
        severity: 'error', rule: 'repair-budget-exhausted',
        title: `Compilation failed after ${MAX_REPAIRS} repair attempt(s)`,
        confidence: 1,
        detail: 'Automatic repair budget is exhausted. Manual review of the generated LaTeX source is required.',
        approval: false,
      });
      break;
    }

    // Apply rule-based repairs
    const { source: repairedSource, repairs } = repairLatex(source, compile.log);
    if (repairs.length === 0) break; // no applicable rules — escalate now
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
// T017 — Human approval gate
// Findings marked approval:true pause the job until POST /api/jobs/:id/approve
// ---------------------------------------------------------------------------
function needsApproval(findings) {
  return findings.some((f) => f.approval && f.severity !== 'pass');
}

async function waitForApproval(job) {
  return new Promise((resolve) => {
    job.status = 'awaiting-approval';
    job.stage = 'Awaiting approval';
    job.approvalResolve = resolve;
  });
}

// ---------------------------------------------------------------------------
// Core job processor
// ---------------------------------------------------------------------------
async function processJob(job) {
  try {
    // Extract
    job.stage = 'Converting'; job.progress = 28;
    job.document = await extractDocx(job.buffer, job.filename);

    // T021 — image-heavy consent gate
    if (isImageHeavy(job.document) && !job.imageHeavyConsent) {
      job.status = 'awaiting-image-consent';
      job.stage = 'Awaiting consent';
      job.findings = [{
        severity: 'warning', rule: 'image-heavy',
        title: `${job.document.figures} images detected — consent required`,
        confidence: 1,
        detail: 'This document is image-heavy. Extraction will proceed but image assets cannot be embedded automatically. Send POST /api/jobs/:id/consent to continue.',
        approval: true,
      }];
      return; // suspend — resumed by /api/jobs/:id/consent
    }

    // Build LaTeX
    job.stage = 'Validating'; job.progress = 55;
    job.source = buildLatex(job.document, job.target);

    // T019 — reconcile bibliography if provided
    if (job.bibBuffer) {
      const bibContent = job.bibBuffer.toString('utf8');
      const { source, bibKeys, unresolved } = reconcileCitations(job.source, bibContent);
      job.source = source;
      job.bibKeys = bibKeys;
      if (unresolved.length > 0) {
        job.findings = job.findings ?? [];
        job.findings.push({
          severity: 'warning', rule: 'citation-integrity',
          title: `${unresolved.length} unresolved citation key(s)`,
          confidence: 0.95,
          detail: `Keys not found in provided bibliography: ${unresolved.slice(0, 5).join(', ')}${unresolved.length > 5 ? ` … and ${unresolved.length - 5} more` : ''}.`,
          approval: false,
        });
      }
      // Write .bib to job dir for pdflatex
      await writeFile(path.join(job.dir, 'refs.bib'), bibContent, 'utf8');
    }

    job.findings = [...(job.findings ?? []), ...validateLatex(job.source, job.document)];

    // T017 — pause for approval if substantive findings present before compile
    if (needsApproval(job.findings)) {
      await waitForApproval(job);
      job.status = 'running';
    }

    // T016 — bounded repair loop (compile → repair → compile, max 3 repairs)
    await compileWithRepairs(job);
    await writeFile(path.join(job.dir, 'input.docx'), job.buffer);

    if (!job.compile.ok) {
      job.findings.unshift({
        severity: 'error', rule: 'compilation',
        title: job.compile.timedOut ? 'Compilation timed out' : 'Compilation failed',
        confidence: 1,
        detail: 'Review compiler log and generated source. Manual correction required.',
        approval: false,
      });
    }

    // Reasoning agent
    job.stage = 'Reasoning'; job.progress = 88;
    job.reasoning = await askReasoning({ findings: job.findings, document: job.document, jobId: job.id });

    // Finalise
    job.stage = 'Ready'; job.progress = 100; job.status = 'ready';
    await writeFile(path.join(job.dir, 'paper.tex'), job.source, 'utf8');
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
  } catch (error) {
    job.status = 'error'; job.stage = 'Escalated';
    job.error = error.message; job.progress = 100;
  }
}

// ---------------------------------------------------------------------------
// T020 — 24-hour retention cleanup worker
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
          jobs.delete(entry); // remove from in-memory map too
        }
      } catch { /* skip entries that can't be stat'd */ }
    }
  } catch { /* cleanup errors are non-fatal */ }
}

// Run cleanup at startup and every 6 hours
runRetentionCleanup();
setInterval(runRetentionCleanup, 6 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    // Health
    if (req.method === 'GET' && req.url === '/api/health') {
      return json(res, 200, { ok: true, service: 'paperforge', jobs: jobs.size });
    }

    // POST /api/jobs — create job
    if (req.method === 'POST' && req.url === '/api/jobs') {
      const { fields, file, bibFile } = await parseUpload(req);
      validateUpload(file);
      const id = `PF-${randomUUID().slice(0, 8).toUpperCase()}`;
      const dir = path.join(jobsRoot, id);
      await mkdir(dir, { recursive: true });
      const job = {
        id, filename: file.filename, size: file.size,
        target: fields.target === 'acmart' ? 'acmart' : 'IEEEtran',
        status: 'running', stage: 'Thinking', progress: 8,
        dir, buffer: file.buffer,
        bibBuffer: bibFile?.buffer ?? null,
        imageHeavyConsent: fields.imageHeavyConsent === 'true',
        createdAt: new Date().toISOString(),
        findings: [], repairsUsed: 0, repairLog: [],
      };
      jobs.set(id, job);
      processJob(job); // fire-and-forget
      return json(res, 202, publicJob(job));
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

    // T017 — POST /api/jobs/:id/approve — resume after human approval gate
    const matchApprove = req.url.match(/^\/api\/jobs\/([^/]+)\/approve$/);
    if (req.method === 'POST' && matchApprove) {
      const job = jobs.get(matchApprove[1]);
      if (!job) return json(res, 404, { error: 'Job not found.' });
      if (job.status !== 'awaiting-approval') return json(res, 409, { error: 'Job is not awaiting approval.' });
      if (typeof job.approvalResolve === 'function') { job.approvalResolve(); delete job.approvalResolve; }
      return json(res, 200, { ok: true, message: 'Approval recorded. Conversion resuming.' });
    }

    // T021 — POST /api/jobs/:id/consent — resume after image-heavy consent gate
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

    // Static file serving
    if (req.method === 'GET') {
      const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
      const file = path.resolve(root, `.${requested}`);
      if (!file.startsWith(root) || file.includes('node_modules')) return res.writeHead(403).end();
      const content = await readFile(file);
      const type = file.endsWith('.css') ? 'text/css'
        : file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript'
        : 'text/html';
      res.writeHead(200, {
        'content-type': `${type}; charset=utf-8`,
        'content-security-policy': "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      return res.end(content);
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    return json(res, 400, { error: error.message || 'Request failed.' });
  }
});

const port = Number(process.env.PORT || 4174);
server.listen(port, '127.0.0.1', () => console.log(`PaperForge backend on http://127.0.0.1:${port}`));
