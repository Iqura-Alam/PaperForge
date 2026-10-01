import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildLatex, extractDocx, validateLatex, validateUpload } from '../src/pipeline.mjs';

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
