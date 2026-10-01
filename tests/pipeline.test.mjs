import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildLatex, extractDocx, repairLatex, validateLatex, validateUpload } from '../src/pipeline.mjs';

test('upload validator enforces DOCX and size limits', () => {
  assert.equal(validateUpload({ filename: 'paper.docx', size: 100, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }).accepted, true);
  assert.throws(() => validateUpload({ filename: 'paper.pdf', size: 100 }), /Only DOCX/);
  assert.throws(() => validateUpload({ filename: 'paper.docx', size: 26 * 1024 * 1024 }), /25 MB/);
});

test('latex generator preserves extracted text and target class', () => {
  const source = buildLatex({ filename: 'paper.docx', blocks: [{ type: 'heading', text: 'A & B' }, { type: 'paragraph', text: 'Scientific result 10%.' }], figures: 0, tables: 0, references: 4 }, 'IEEEtran');
  assert.match(source, /IEEEtran/); assert.match(source, /A \\& B/); assert.match(source, /Scientific result 10\\%/);
  assert.equal(validateLatex(source, { figures: 0, tables: 0, references: 4 }).at(-1).severity, 'pass');
});

test('DOCX parser extracts headings and body text from a real package', async () => {
  const document = await extractDocx(await readFile('tests/fixtures/minimal.docx'), 'minimal.docx');
  assert.equal(document.headings[0].text, 'Real DOCX extraction');
  assert.match(document.text, /Scientific content remains editable/);
});

// T022 — New tests for Phase 5 features

test('repairLatex applies hyperref fix when log signals the error', () => {
  const source = '\\documentclass{IEEEtran}\n\\begin{document}\nHello.\n\\end{document}\n';
  const log = 'Package hyperref Error: Something went wrong.';
  const { source: repaired, repairs } = repairLatex(source, log);
  assert.ok(repaired.includes('\\usepackage{hyperref}'), 'hyperref package must be injected');
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].rule, 'missing-usepackage-hyperref');
  assert.equal(repairs[0].approval, false, 'formatting repair must not require approval');
});

test('repairLatex replaces broken includegraphics with placeholder when file not found', () => {
  const source = '\\documentclass{IEEEtran}\n\\begin{document}\n\\includegraphics[width=1cm]{missing_fig.png}\n\\end{document}\n';
  const log = 'File `missing_fig.png` not found.';
  const { source: repaired, repairs } = repairLatex(source, log);
  assert.ok(!repaired.includes('\\includegraphics'), 'broken includegraphics must be replaced');
  assert.ok(repaired.includes('\\fbox{'), 'placeholder fbox must be inserted');
  assert.equal(repairs.length, 1);
});

test('repairLatex makes no changes when log has no matching error patterns', () => {
  const source = '\\documentclass{IEEEtran}\n\\begin{document}\nClean source.\n\\end{document}\n';
  const log = 'Everything compiled fine.';
  const { source: unchanged, repairs } = repairLatex(source, log);
  assert.equal(unchanged, source, 'source must not be mutated when no rule matches');
  assert.equal(repairs.length, 0);
});

test('askReasoning returns rule-based result when no API key is configured', async () => {
  const savedGemini = process.env.GEMINI_API_KEY;
  const savedOpenAI = process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  // Dynamic import to pick up env state at call time
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
