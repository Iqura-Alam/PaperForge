import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLatex } from '../src/pipeline.mjs';

function count(source, literal) {
  return source.split(literal).length - 1;
}

test('front matter preserves unclassified author notes exactly once', () => {
  const correspondingAuthorNote = '† Corresponding author and equal contribution.';
  const document = {
    filename: 'front-matter.docx',
    blocks: [
      { type: 'heading', level: 1, text: 'Exact Front Matter' },
      { type: 'paragraph', text: 'Ada Lovelace' },
      { type: 'paragraph', text: 'Analytical Engine Institute' },
      { type: 'paragraph', text: 'ada@example.org' },
      { type: 'paragraph', text: correspondingAuthorNote },
      { type: 'heading', level: 1, text: 'Abstract' },
      { type: 'paragraph', text: 'The abstract is preserved.' },
      { type: 'heading', level: 1, text: 'Introduction' },
      { type: 'paragraph', text: 'The scientific body begins here.' },
    ],
    authorInfo: {
      authors: ['Ada Lovelace'],
      institutions: ['Analytical Engine Institute'],
      emails: ['ada@example.org'],
    },
    tables: [], figures: 0, references: 0,
  };

  const source = buildLatex(document, 'IEEEtran');
  assert.equal(count(source, 'Ada Lovelace'), 1);
  assert.equal(count(source, 'Analytical Engine Institute'), 1);
  assert.equal(count(source, 'ada@example.org'), 1);
  assert.equal(count(source, correspondingAuthorNote), 1, 'Unclassified front matter must not be silently deleted');
  assert.equal(count(source, 'The scientific body begins here.'), 1);
});

test('a document without an Abstract heading does not lose its first body blocks', () => {
  const document = {
    filename: 'no-abstract.docx',
    blocks: [
      { type: 'heading', level: 1, text: 'Paper Without Abstract Heading' },
      { type: 'paragraph', text: 'First scientific paragraph.' },
      { type: 'figure', caption: 'First scientific figure' },
      { type: 'paragraph', text: 'Second scientific paragraph.' },
    ],
    authorInfo: { authors: [], institutions: [], emails: [] },
    tables: [], figures: 1, references: 0,
  };

  const source = buildLatex(document, 'IEEEtran');
  assert.match(source, /First scientific paragraph\./);
  assert.match(source, /\\begin\{figure\}/);
  assert.match(source, /Second scientific paragraph\./);
});

test('wide tables are bounded to the output column and preserve caption/header metadata', () => {
  const caption = 'A deliberately wide benchmark table';
  const document = {
    filename: 'wide-table.docx',
    blocks: [
      { type: 'heading', level: 1, text: 'Wide Table Paper' },
      { type: 'heading', level: 1, text: 'Abstract' },
      { type: 'paragraph', text: 'Table layout is evaluated.' },
      { type: 'heading', level: 1, text: 'Results' },
      {
        type: 'table',
        caption,
        headerRows: 1,
        rows: [
          ['Model configuration', 'Very long evaluation metric heading', 'Ablation and implementation notes'],
          ['Baseline model with verbose name', '0.812', 'Long explanatory text that must wrap instead of overlapping body text'],
        ],
      },
    ],
    authorInfo: { authors: [], institutions: [], emails: [] },
    tables: [{}], figures: 0, references: 0,
  };

  const source = buildLatex(document, 'IEEEtran');
  assert.match(source, new RegExp(`\\\\caption\\{${caption}\\}`));
  assert.match(
    source,
    /\\begin\{tabularx\}\{(?:\\columnwidth|\\linewidth)\}|\\resizebox\{(?:\\columnwidth|\\linewidth)\}\{!\}/,
    'Tables must be mechanically bounded to the current column width',
  );
  assert.match(source, /\\textbf\{Model configuration\}|\\toprule/, 'Header-row metadata must affect rendering');
});

test('agent proposals expose typed validation plus deterministic apply/reject revision helpers', async () => {
  const pipeline = await import('../src/pipeline.mjs');
  assert.equal(typeof pipeline.validateAgentProposal, 'function', 'Missing typed proposal validator');
  assert.equal(typeof pipeline.applyAgentProposal, 'function', 'Missing deterministic proposal apply helper');
  assert.equal(typeof pipeline.rejectAgentProposal, 'function', 'Missing proposal rejection helper');

  const proposal = pipeline.validateAgentProposal({
    id: 'proposal-1',
    type: 'formatting-replacement',
    baseRevision: 4,
    payload: { search: '\\begin{tabular}', replacement: '\\begin{tabularx}' },
  });
  const applied = pipeline.applyAgentProposal({
    source: '\\begin{tabular}',
    revision: 4,
    expectedRevision: 4,
    proposal,
  });
  assert.equal(applied.source, '\\begin{tabularx}');
  assert.equal(applied.revision, 5);
  assert.equal(applied.proposal.status, 'applied');
  assert.throws(
    () => pipeline.applyAgentProposal({ source: applied.source, revision: 5, expectedRevision: 4, proposal }),
    /revision|stale|conflict/i,
  );

  const rejected = pipeline.rejectAgentProposal({ proposal: { ...proposal, status: 'pending' }, revision: 4 });
  assert.equal(rejected.proposal.status, 'rejected');
  assert.equal(rejected.revision, 4, 'Rejecting must not mutate the document revision');
});
