export const stages = ['Thinking', 'Converting', 'Compiling', 'Validating', 'Repairing', 'Ready'];

const baseFindings = [
  { id: 'F-001', severity: 'error', rule: 'citation-integrity', title: 'Citation key not found', detail: 'Reference [14] appears in the manuscript but is missing from the supplied bibliography.', confidence: 0.91, location: 'Introduction, paragraph 3', approval: true },
  { id: 'F-002', severity: 'warning', rule: 'asset-presence', title: 'Figure asset needs review', detail: 'Figure 2 uses a relative path that could not be verified in the source package.', confidence: 0.73, location: 'Figure 2 caption', approval: false },
  { id: 'F-003', severity: 'warning', rule: 'table-structure', title: 'Merged table cells detected', detail: 'Table 1 contains merged cells. The reconstruction is ready for visual review.', confidence: 0.68, location: 'Results, Table 1', approval: true },
  { id: 'F-004', severity: 'pass', rule: 'content-preservation', title: 'Scientific text preserved', detail: 'Title, abstract, sections, equations, and references were mapped without paraphrase.', confidence: 0.98, location: 'Whole manuscript', approval: false }
];

export function createDemoJob() {
  return {
    id: 'PF-1042',
    filename: 'neural-interface-study.docx',
    size: '4.8 MB',
    pages: 18,
    figures: 7,
    tables: 4,
    references: 42,
    target: 'IEEEtran',
    status: 'intent',
    stage: 'Thinking',
    progress: 8,
    repairsUsed: 0,
    lastUpdated: 'Just now',
    findings: baseFindings.map((finding) => ({ ...finding })),
    ledger: [{ stage: 'Thinking', label: 'Intent preview ready', state: 'current', rationale: 'Confirm scope, target template, and approval boundary before touching source.' }],
    outputs: { source: true, pdf: false, report: false, changelog: false }
  };
}

export function advanceJob(job) {
  const currentIndex = stages.indexOf(job.stage);
  if (currentIndex < 0 || currentIndex >= stages.length - 1) return job;
  const nextStage = stages[currentIndex + 1];
  const nextProgress = { Converting: 28, Compiling: 54, Validating: 74, Repairing: 88, Ready: 100 }[nextStage] ?? job.progress;
  const nextStatus = nextStage === 'Ready' ? 'ready' : 'running';
  const nextEntry = {
    stage: nextStage,
    label: nextStage === 'Ready' ? 'Outputs ready for review' : `${nextStage} in progress`,
    state: nextStage === 'Ready' ? 'complete' : 'current',
    rationale: {
      Converting: 'Map document structure into editable LaTeX while preserving text and order.',
      Compiling: 'Compile target source and capture warnings before proposing repairs.',
      Validating: 'Check references, assets, tables, and template rules against the source model.',
      Repairing: 'Apply only bounded formatting repairs. Substantive edits stay paused for approval.',
      Ready: 'Conversion package is assembled. Remaining findings need human review.'
    }[nextStage]
  };
  return { ...job, stage: nextStage, status: nextStatus, progress: nextProgress, lastUpdated: 'Just now', ledger: [...job.ledger.map((entry) => ({ ...entry, state: entry.state === 'current' ? 'complete' : entry.state })), nextEntry], outputs: nextStage === 'Ready' ? { source: true, pdf: true, report: true, changelog: true } : job.outputs };
}

export function filterFindings(findings, query) {
  const normalized = String(query ?? 'all').toLowerCase();
  if (normalized === 'all') return findings;
  return findings.filter((finding) => finding.severity === normalized || finding.title.toLowerCase().includes(normalized) || finding.rule.includes(normalized));
}
