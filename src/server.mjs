import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import Busboy from 'busboy';
import { askReasoning, buildLatex, compileLatex, extractDocx, validateLatex, validateUpload } from './pipeline.mjs';

const root = path.resolve('.'); const jobsRoot = path.join(root, '.codex-local', 'jobs'); const jobs = new Map(); await mkdir(jobsRoot, { recursive: true });
function json(res, status, payload) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(payload)); }
function safeName(value) { return path.basename(value).replace(/[^a-zA-Z0-9._-]/g, '_'); }
function publicJob(job) { const { buffer, document, source, dir, ...safe } = job; return { ...safe, document: document ? { figures: document.figures, tables: document.tables.length, references: document.references } : undefined, compile: job.compile ? { ok: job.compile.ok, pdf: job.compile.pdf, timedOut: job.compile.timedOut } : undefined }; }

async function parseUpload(req) {
  return new Promise((resolve, reject) => {
    const fields = {}; let file = null; const parser = Busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 4 } });
    parser.on('field', (name, value) => { fields[name] = value; });
    parser.on('file', (name, stream, info) => { const chunks = []; file = { field: name, filename: safeName(info.filename), mimeType: info.mimeType, size: 0 }; stream.on('data', (chunk) => { file.size += chunk.length; chunks.push(chunk); }); stream.on('limit', () => reject(new Error('DOCX file exceeds the 25 MB limit.'))); stream.on('end', () => { file.buffer = Buffer.concat(chunks); }); });
    parser.on('error', reject); parser.on('finish', () => file ? resolve({ fields, file }) : reject(new Error('No manuscript file was uploaded.'))); req.pipe(parser);
  });
}

async function processJob(job) {
  try {
    job.stage = 'Converting'; job.progress = 28; job.document = await extractDocx(job.buffer, job.filename);
    job.stage = 'Validating'; job.progress = 55; job.source = buildLatex(job.document, job.target); job.findings = validateLatex(job.source, job.document);
    job.stage = 'Compiling'; job.progress = 72; await writeFile(path.join(job.dir, 'input.docx'), job.buffer); job.compile = await compileLatex({ source: job.source, jobDir: job.dir, target: job.target });
    if (!job.compile.ok) job.findings.unshift({ severity: 'error', rule: 'compilation', title: job.compile.timedOut ? 'Compilation timed out' : 'Compilation failed', confidence: 1, detail: 'Review compiler log and generated source before retrying.' });
    job.stage = 'Reasoning'; job.progress = 88; job.reasoning = await askReasoning({ findings: job.findings, document: job.document, jobId: job.id });
    job.stage = job.compile.ok ? 'Ready' : 'Escalated'; job.progress = 100; job.status = job.compile.ok ? 'ready' : 'error'; await writeFile(path.join(job.dir, 'paper.tex'), job.source, 'utf8'); await writeFile(path.join(job.dir, 'validation.json'), JSON.stringify({ jobId: job.id, findings: job.findings, compile: job.compile, reasoning: job.reasoning }, null, 2)); await writeFile(path.join(job.dir, 'change-log.md'), `# Change log\n\n- Generated editable LaTeX from DOCX structure.\n- Applied no semantic rewrites.\n- ${job.findings.length} validation findings recorded.\n`);
  } catch (error) { job.status = 'error'; job.stage = 'Escalated'; job.error = error.message; job.progress = 100; }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { ok: true, service: 'paperforge', jobs: jobs.size });
    if (req.method === 'POST' && req.url === '/api/jobs') { const { fields, file } = await parseUpload(req); validateUpload(file); const id = `PF-${randomUUID().slice(0, 8).toUpperCase()}`; const dir = path.join(jobsRoot, id); await mkdir(dir, { recursive: true }); const job = { id, filename: file.filename, size: file.size, target: fields.target === 'acmart' ? 'acmart' : 'IEEEtran', status: 'running', stage: 'Thinking', progress: 8, dir, buffer: file.buffer, createdAt: new Date().toISOString(), findings: [] }; jobs.set(id, job); processJob(job); return json(res, 202, publicJob(job)); }
    const match = req.url.match(/^\/api\/jobs\/([^/]+)(?:\/output\/([^/]+))?$/);
    if (req.method === 'GET' && match) { const job = jobs.get(match[1]); if (!job) return json(res, 404, { error: 'Job not found.' }); if (!match[2]) return json(res, 200, publicJob(job)); const allowed = { source: 'paper.tex', report: 'validation.json', changelog: 'change-log.md', pdf: 'paper.pdf' }; const filename = allowed[match[2]]; if (!filename) return json(res, 404, { error: 'Output not found.' }); const content = await readFile(path.join(job.dir, filename)); res.writeHead(200, { 'content-type': filename.endsWith('.pdf') ? 'application/pdf' : 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"` }); return res.end(content); }
    if (req.method === 'GET') { const requested = req.url === '/' ? '/index.html' : req.url; const file = path.resolve(root, `.${requested}`); if (!file.startsWith(root) || file.includes('node_modules')) return res.writeHead(403).end(); const content = await readFile(file); const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') || file.endsWith('.mjs') ? 'text/javascript' : 'text/html'; res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'content-security-policy': "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" }); return res.end(content); }
    return json(res, 405, { error: 'Method not allowed.' });
  } catch (error) { return json(res, 400, { error: error.message || 'Request failed.' }); }
});
const port = Number(process.env.PORT || 4174); server.listen(port, '127.0.0.1', () => console.log(`PaperForge backend on http://127.0.0.1:${port}`));
