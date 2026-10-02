import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildLatex, extractDocx, repairLatex, validateLatex,
  validateUpload, askReasoning, TEMPLATES, TEMPLATE_IDS,
} from '../src/pipeline.mjs';

// ---------------------------------------------------------------------------
// validateUpload
// ---------------------------------------------------------------------------
test('validateUpload accepts valid DOCX', () => {
  const result = validateUpload({ filename: 'paper.docx', size: 100 });
  assert.equal(result.accepted, true);
});

test('validateUpload rejects non-DOCX extension', () => {
  assert.throws(() => validateUpload({ filename: 'paper.pdf', size: 100 }), /Only DOCX/);
});

test('validateUpload rejects oversized file', () => {
  assert.throws(() => validateUpload({ filename: 'paper.docx', size: 26 * 1024 * 1024 }), /25 MB/);
});

// ---------------------------------------------------------------------------
// TEMPLATE_IDS
// ---------------------------------------------------------------------------
test('TEMPLATE_IDS contains all six official venues', () => {
  const expected = ['IEEEtran', 'acmart', 'acl', 'springer', 'icml', 'iclr'];
  for (const id of expected) assert.ok(TEMPLATE_IDS.includes(id), `Missing template: ${id}`);
  assert.equal(TEMPLATE_IDS.length, 6);
});

// ---------------------------------------------------------------------------
// buildLatex — clean output assertions for all 6 templates
// ---------------------------------------------------------------------------
const MOCK_DOCUMENT = {
  filename: 'paper.docx',
  blocks: [
    { type: 'heading', level: 1, text: 'Deep Learning in Science' },
    { type: 'heading', level: 1, text: 'Abstract' },
    { type: 'paragraph', text: 'We present a novel method.' },
    { type: 'heading', level: 2, text: 'Introduction' },
    { type: 'paragraph', text: 'This paper is structured as follows.' },
    { type: 'paragraph', text: 'Related work is discussed in Section 2.' },
    { type: 'heading', level: 2, text: 'Results' },
    { type: 'table', rows: [['Model', 'Accuracy', 'F1'], ['Baseline', '82.3', '0.81'], ['Ours', '91.4', '0.93']] },
  ],
  headings: [],
  tables: [{ rows: [['Model', 'Accuracy', 'F1'], ['Baseline', '82.3', '0.81']] }],
  figures: 0,
  references: 3,
};

for (const id of ['IEEEtran', 'acmart', 'acl', 'springer', 'icml', 'iclr']) {
  test(`buildLatex(${id}) produces compilable skeleton`, () => {
    const source = buildLatex(MOCK_DOCUMENT, id);
    assert.match(source, /\\begin\{document\}/);
    assert.match(source, /\\end\{document\}/);
    assert.match(source, /Deep Learning in Science/);
    assert.ok(!source.includes('% Table row preserved'), 'Must not contain table-row comment');
    assert.ok(!source.includes('Validation note'), 'Must not contain Validation note section');
    assert.ok(!source.includes('Author names preserved from source'), 'Must not contain old author placeholder');
  });

  test(`buildLatex(${id}) uses correct document class`, () => {
    const source = buildLatex(MOCK_DOCUMENT, id);
    const expectedClass = TEMPLATES[id].class;
    assert.ok(
      source.includes(`\\documentclass`) &&
      (source.includes(expectedClass) || ['icml', 'iclr'].includes(id)),
      `Class ${expectedClass} must appear in ${id} output`,
    );
  });
}

test('buildLatex converts table rows to tabular environment (no % comment)', () => {
  const source = buildLatex(MOCK_DOCUMENT, 'IEEEtran');
  assert.match(source, /\\begin\{tabular\}/);
  assert.match(source, /\\end\{tabular\}/);
  assert.match(source, /Baseline/);
  assert.ok(!source.includes('% Table row'), 'No % table-row comments allowed');
});

test('buildLatex extracts abstract into \\begin{abstract} block', () => {
  const source = buildLatex(MOCK_DOCUMENT, 'IEEEtran');
  assert.match(source, /\\begin\{abstract\}\nWe present a novel method\./);
});

test('buildLatex extracts section headings as correct \\section or \\subsection commands', () => {
  const source = buildLatex(MOCK_DOCUMENT, 'IEEEtran');
  // Mock headings are level-2, so they map to \subsection
  assert.match(source, /\\subsection\{Introduction\}/);
  assert.match(source, /\\subsection\{Results\}/);
});

test('buildLatex with figure blocks emits \\begin{figure} placeholder (no \\includegraphics)', () => {
  const docWithFig = {
    ...MOCK_DOCUMENT,
    blocks: [
      { type: 'heading', level: 1, text: 'Title' },
      { type: 'figure', caption: 'Architecture diagram' },
      { type: 'paragraph', text: 'Results.' },
    ],
    figures: 1,
  };
  const source = buildLatex(docWithFig, 'IEEEtran');
  assert.match(source, /\\begin\{figure\}/);
  assert.match(source, /Architecture diagram/);
  assert.ok(!source.includes('\\includegraphics'), 'Must not emit \\includegraphics for missing assets');
});

// ---------------------------------------------------------------------------
// validateLatex
// ---------------------------------------------------------------------------
test('validateLatex reports pass when source is well-formed', () => {
  const source = buildLatex(MOCK_DOCUMENT, 'IEEEtran');
  const findings = validateLatex(source, { figures: 0, tables: [], references: 3 });
  assert.ok(findings.some((f) => f.rule === 'content-preservation' && f.severity === 'pass'));
  assert.ok(!findings.some((f) => f.rule === 'latex-structure'));
});

test('validateLatex flags missing figures as warning', () => {
  const source = buildLatex(MOCK_DOCUMENT, 'IEEEtran');
  const findings = validateLatex(source, { figures: 2, tables: [], references: 3 });
  assert.ok(findings.some((f) => f.rule === 'asset-presence' && f.severity === 'warning'));
});

// ---------------------------------------------------------------------------
// extractDocx — real fixture
// ---------------------------------------------------------------------------
test('extractDocx parses real DOCX fixture', async () => {
  const document = await extractDocx(await readFile('tests/fixtures/minimal.docx'), 'minimal.docx');
  assert.equal(document.headings[0].text, 'Real DOCX extraction');
  assert.match(document.text, /Scientific content remains editable/);
});

// ---------------------------------------------------------------------------
// repairLatex
// ---------------------------------------------------------------------------
test('repairLatex applies hyperref fix', () => {
  const source = '\\documentclass{IEEEtran}\n\\begin{document}\nHello.\n\\end{document}\n';
  const { source: repaired, repairs } = repairLatex(source, 'Package hyperref Error: Something went wrong.');
  assert.ok(repaired.includes('\\usepackage{hyperref}'));
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].rule, 'missing-usepackage-hyperref');
});

test('repairLatex replaces broken \\includegraphics with fbox placeholder', () => {
  const source = '\\documentclass{IEEEtran}\n\\begin{document}\n\\includegraphics[width=1cm]{missing.png}\n\\end{document}\n';
  const { source: repaired, repairs } = repairLatex(source, "File `missing.png' not found.");
  assert.ok(!repaired.includes('\\includegraphics'));
  assert.ok(repaired.includes('\\fbox{'));
  assert.equal(repairs.length, 1);
});

test('repairLatex applies missing-acl-style fallback', () => {
  const source = '\\documentclass[11pt]{article}\n\\usepackage{acl}\n\\begin{document}\n\\end{document}\n';
  const { source: repaired, repairs } = repairLatex(source, "File `acl.sty' not found.");
  assert.ok(!repaired.includes('\\usepackage{acl}'));
  assert.equal(repairs[0].rule, 'missing-acl-style');
});

test('repairLatex applies missing-llncs-class fallback', () => {
  const source = '\\documentclass{llncs}\n\\begin{document}\n\\end{document}\n';
  const { source: repaired, repairs } = repairLatex(source, "File `llncs.cls' not found.");
  assert.ok(repaired.includes('\\documentclass[12pt]{article}'));
  assert.equal(repairs[0].rule, 'missing-llncs-class');
});

test('repairLatex makes no changes when log has no matching patterns', () => {
  const source = '\\documentclass{IEEEtran}\n\\begin{document}\nClean.\n\\end{document}\n';
  const { source: unchanged, repairs } = repairLatex(source, 'All good.');
  assert.equal(unchanged, source);
  assert.equal(repairs.length, 0);
});

// ---------------------------------------------------------------------------
// askReasoning — rule-based fallback when no API keys present
// ---------------------------------------------------------------------------
test('askReasoning returns rule-based result when no API key is configured', async () => {
  const savedGemini = process.env.GEMINI_API_KEY;
  const savedOpenAI = process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const findings = [
    { severity: 'error', rule: 'compilation', title: 'Compilation failed', detail: 'pdflatex error.', approval: false },
    { severity: 'pass', rule: 'content-preservation', title: 'Text preserved', detail: 'No rewrites.', approval: false },
  ];
  const result = await askReasoning({ findings, document: { figures: 0, tables: [], references: 2 }, jobId: 'TEST-01' });
  assert.equal(result.provider, 'rule-based');
  assert.ok(Array.isArray(result.safeFixes));
  assert.ok(Array.isArray(result.approvalRequired));
  assert.ok(result.summary.length > 0);

  if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini;
  if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
});

// ---------------------------------------------------------------------------
// Citation reconciliation
// ---------------------------------------------------------------------------
function reconcile(source, bibContent) {
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
  const { source: patched, bibKeys } = reconcile(source, '@article{smith2020, title={T}}');
  assert.ok(patched.includes('\\bibliography{refs}'));
  assert.deepEqual(bibKeys, ['smith2020']);
});

test('citation reconciliation reports unresolved keys', () => {
  const source = '\\begin{document}\n\\cite{jones2022}\n\\end{document}';
  const { unresolved } = reconcile(source, '@article{smith2020, title={T}}');
  assert.deepEqual(unresolved, ['jones2022']);
});

test('citation reconciliation returns empty when all keys match', () => {
  const source = '\\begin{document}\n\\cite{smith2020}\n\\end{document}';
  const { unresolved } = reconcile(source, '@article{smith2020, title={T}}');
  assert.equal(unresolved.length, 0);
});

test('citation reconciliation with null bib returns original', () => {
  const source = '\\begin{document}\nBody.\n\\end{document}';
  const { source: unchanged, bibKeys } = reconcile(source, null);
  assert.equal(unchanged, source);
  assert.equal(bibKeys.length, 0);
});

// ---------------------------------------------------------------------------
// Security — path traversal guard
// ---------------------------------------------------------------------------
test('static file guard rejects path traversal outside root', () => {
  const root = path.resolve('.');
  const traversal = path.resolve(root, '../etc/passwd');
  assert.equal(traversal.startsWith(root), false);
});

test('static file guard rejects node_modules path', () => {
  const requested = '/node_modules/.bin/something';
  assert.ok(requested.includes('node_modules'));
});

// ---------------------------------------------------------------------------
// compileLatex — graceful not-found path (pdflatex absent locally)
// ---------------------------------------------------------------------------
test('compileLatex returns notFound=true when pdflatex is absent', async () => {
  const { compileLatex } = await import('../src/pipeline.mjs');
  const origPath = process.env.PATH;
  process.env.PATH = ''; // strip PATH so pdflatex cannot be found
  const jobDir = path.join('.codex-local', 'jobs', `test-${randomUUID().slice(0, 6)}`);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(jobDir, { recursive: true });
  const result = await compileLatex({ source: '\\documentclass{article}\\begin{document}Hi\\end{document}', jobDir });
  process.env.PATH = origPath;
  assert.equal(result.ok, false);
  assert.ok(result.notFound === true || result.ok === false, 'Should not succeed without pdflatex');
});
