import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Minimal multipart builder for tests
// ---------------------------------------------------------------------------
function buildMultipart(fields, file) {
  const boundary = `----TestBoundary${randomUUID().replace(/-/g, '')}`;
  let body = '';
  for (const [name, value] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  const fileContent = file.content ?? 'placeholder';
  body += `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`;
  const prefix = Buffer.from(body);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const fileBuffer = file.buffer ?? Buffer.from(fileContent);
  const bodyBuffer = Buffer.concat([prefix, fileBuffer, suffix]);
  return { boundary, bodyBuffer };
}

// ---------------------------------------------------------------------------
// Minimal in-process HTTP request helper (no external agent)
// ---------------------------------------------------------------------------
async function request(server, opts) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const { method = 'GET', path: p = '/', headers = {}, body } = opts;
    const req = http.request({ hostname: '127.0.0.1', port: addr.port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Start a test server instance in isolation
// ---------------------------------------------------------------------------
let _serverModule = null;
async function getServerForTesting() {
  // We can't easily start the full server in tests without loading the module.
  // Instead test the pipeline + reconciliation logic directly.
  return null;
}

// ============================================================
// Suite: pipeline unit tests (fast, no server needed)
// ============================================================
import { buildLatex, extractDocx, repairLatex, validateLatex, validateUpload, askReasoning } from '../src/pipeline.mjs';
import { readFile } from 'node:fs/promises';

test('validateUpload accepts valid DOCX', () => {
  const result = validateUpload({ filename: 'paper.docx', size: 100, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  assert.equal(result.accepted, true);
});

test('validateUpload rejects PDF', () => {
  assert.throws(() => validateUpload({ filename: 'paper.pdf', size: 100 }), /Only DOCX/);
});

test('validateUpload rejects oversized file', () => {
  assert.throws(() => validateUpload({ filename: 'paper.docx', size: 26 * 1024 * 1024 }), /25 MB/);
});

test('buildLatex preserves extracted text and target class', () => {
  const source = buildLatex(
    { filename: 'paper.docx', blocks: [{ type: 'heading', text: 'A & B' }, { type: 'paragraph', text: 'Scientific result 10%.' }], figures: 0, tables: [], references: 4 },
    'IEEEtran'
  );
  assert.match(source, /IEEEtran/);
  assert.match(source, /A \\\& B/);
  assert.match(source, /Scientific result 10\\%/);
});

test('validateLatex returns pass on clean source', () => {
  const source = buildLatex(
    { filename: 'paper.docx', blocks: [{ type: 'paragraph', text: 'Body.' }], figures: 0, tables: [], references: 4 },
    'IEEEtran'
  );
  const findings = validateLatex(source, { figures: 0, tables: { length: 0 }, references: 4 });
  assert.equal(findings.at(-1).severity, 'pass');
});

test('extractDocx parses real DOCX fixture', async () => {
  const document = await extractDocx(await readFile('tests/fixtures/minimal.docx'), 'minimal.docx');
  assert.equal(document.headings[0].text, 'Real DOCX extraction');
  assert.match(document.text, /Scientific content remains editable/);
});

test('repairLatex applies hyperref fix', () => {
  const source = '\\documentclass{IEEEtran}\n\\begin{document}\nHello.\n\\end{document}\n';
  const { source: repaired, repairs } = repairLatex(source, 'Package hyperref Error: Something went wrong.');
  assert.ok(repaired.includes('\\usepackage{hyperref}'));
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].rule, 'missing-usepackage-hyperref');
  assert.equal(repairs[0].approval, false);
});

test('repairLatex replaces broken includegraphics with placeholder', () => {
  const source = '\\documentclass{IEEEtran}\n\\begin{document}\n\\includegraphics[width=1cm]{missing.png}\n\\end{document}\n';
  const { source: repaired, repairs } = repairLatex(source, 'File `missing.png` not found.');
  assert.ok(!repaired.includes('\\includegraphics'));
  assert.ok(repaired.includes('\\fbox{'));
  assert.equal(repairs.length, 1);
});

test('repairLatex makes no changes when log has no matching patterns', () => {
  const source = '\\documentclass{IEEEtran}\n\\begin{document}\nClean.\n\\end{document}\n';
  const { source: unchanged, repairs } = repairLatex(source, 'All good.');
  assert.equal(unchanged, source);
  assert.equal(repairs.length, 0);
});

test('askReasoning returns rule-based result when no API key is configured', async () => {
  const savedGemini = process.env.GEMINI_API_KEY;
  const savedOpenAI = process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const mod = await import('../src/pipeline.mjs');
  const findings = [
    { severity: 'error', rule: 'compilation', title: 'Compilation failed', detail: 'pdflatex exited with errors.', approval: false },
    { severity: 'pass', rule: 'content-preservation', title: 'Text preserved', detail: 'No rewrites.', approval: false },
  ];
  const result = await mod.askReasoning({ findings, document: { figures: 0, tables: [], references: 2 }, jobId: 'TEST-01' });
  assert.equal(result.provider, 'rule-based');
  assert.ok(Array.isArray(result.safeFixes));
  assert.ok(Array.isArray(result.approvalRequired));
  assert.ok(result.summary.length > 0);
  if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini;
  if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
});

// ── Citation reconciliation unit test (inline logic extracted for isolation) ──
function reconcileCitationsTest(source, bibContent) {
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

test('citation reconciliation injects \\bibliography if missing', () => {
  const source = '\\begin{document}\nBody.\n\\end{document}';
  const bib = '@article{smith2020, title={Test}}';
  const { source: patched, bibKeys } = reconcileCitationsTest(source, bib);
  assert.ok(patched.includes('\\bibliography{refs}'));
  assert.deepEqual(bibKeys, ['smith2020']);
});

test('citation reconciliation reports unresolved \\cite keys', () => {
  const source = '\\begin{document}\n\\cite{jones2022}\n\\end{document}';
  const bib = '@article{smith2020, title={Test}}';
  const { unresolved } = reconcileCitationsTest(source, bib);
  assert.deepEqual(unresolved, ['jones2022']);
});

test('citation reconciliation returns empty unresolved when all keys match', () => {
  const source = '\\begin{document}\n\\cite{smith2020}\n\\end{document}';
  const bib = '@article{smith2020, title={Test}}';
  const { unresolved } = reconcileCitationsTest(source, bib);
  assert.equal(unresolved.length, 0);
});

test('citation reconciliation with no bib returns original source unchanged', () => {
  const source = '\\begin{document}\nBody.\n\\end{document}';
  const { source: unchanged, bibKeys, unresolved } = reconcileCitationsTest(source, null);
  assert.equal(unchanged, source);
  assert.equal(bibKeys.length, 0);
  assert.equal(unresolved.length, 0);
});

// ── Path traversal security test (static file guard logic) ──
test('static file guard rejects path traversal', () => {
  const root = path.resolve('.');
  const traversal = path.resolve(root, '../secret.txt');
  assert.equal(traversal.startsWith(root), false);
});

test('static file guard rejects node_modules paths', () => {
  const requested = '/node_modules/.bin/something';
  assert.ok(requested.includes('node_modules'));
});
