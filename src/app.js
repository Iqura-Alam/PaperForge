import { advanceJob, createDemoJob, filterFindings, stages } from './state.js';

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
const icons = {
  file:     '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h5M9 13h6M9 17h6"/></svg>',
  arrow:    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
  check:    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>',
  info:     '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 10v6M12 7h.01"/></svg>',
  spark:    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 14 9l6 2-6 2-2 6-2-6-6-2 6-2z"/></svg>',
  upload:   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V9M7 14l5-5 5 5M5 20h14"/></svg>',
  rollback: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7v6h6M3 13a9 9 0 1 0 2.83-6.36"/></svg>',
  cancel:   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  diff:     '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h8M4 18h12"/></svg>',
  bib:      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v4H4zM4 12h10M4 16h7"/></svg>',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let job = null;          // current active job
let findingFilter = 'all';
let diffData = null;     // { original, repaired, repairs }
let showDiff = false;
let sseController = null; // AbortController for SSE stream

// ---------------------------------------------------------------------------
// Utility: normalise server job into local shape
// ---------------------------------------------------------------------------
function normalizeServerJob(serverJob) {
  return {
    ...createDemoJob(),
    ...serverJob,
    real: true,
    size: typeof serverJob.size === 'number'
      ? `${(serverJob.size / 1024 / 1024).toFixed(1)} MB`
      : serverJob.size,
    figures: serverJob.document?.figures ?? 0,
    tables: serverJob.document?.tables ?? 0,
    references: serverJob.document?.references ?? 0,
    findings: serverJob.findings ?? [],
    outputs: {
      source: Boolean(serverJob.document),
      pdf: Boolean(serverJob.compile?.pdf),
      report: Boolean(serverJob.document),
      changelog: Boolean(serverJob.document),
    },
  };
}

// ---------------------------------------------------------------------------
// SSE: real-time progress stream
// ---------------------------------------------------------------------------
function connectSSE(id) {
  if (sseController) sseController.abort();
  sseController = new AbortController();
  const es = new EventSource(`/api/jobs/${id}/events`);

  es.addEventListener('job', (e) => {
    try {
      const updated = JSON.parse(e.data);
      job = normalizeServerJob(updated);
      render();
    } catch { /* ignore malformed */ }
  });

  es.addEventListener('done', () => { es.close(); sseController = null; });
  es.addEventListener('cancelled', () => { es.close(); sseController = null; job = null; render(); });
  es.addEventListener('error', () => {
    // SSE error (server closed or network issue)
    if (job && !['ready', 'error', 'rolled-back', 'cancelled'].includes(job.status)) {
      // Fall back to polling once
      window.setTimeout(() => watchServerJobOnce(id), 2000);
    }
    es.close();
  });

  // Abort if caller calls abort()
  sseController.signal.addEventListener('abort', () => es.close());
}

async function watchServerJobOnce(id) {
  try {
    const r = await fetch(`/api/jobs/${id}`);
    if (!r.ok) return;
    job = normalizeServerJob(await r.json());
    render();
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Rendering root
// ---------------------------------------------------------------------------
const appRoot = document.querySelector('#app');
const announce = (msg) => { document.querySelector('#live-region').textContent = msg; };

// ---------------------------------------------------------------------------
// Upload prompt (no job loaded)
// ---------------------------------------------------------------------------
function renderUploadPrompt() {
  return `
    <aside class="sidebar" aria-label="Primary navigation">
      <div class="brand"><span class="brand-mark">P</span><span>PaperForge</span></div>
      <nav class="nav-list">
        <button class="nav-item active" type="button" id="nav-workspace" data-nav="workspace"><span class="nav-icon">${icons.file}</span>Workspace</button>
        <button class="nav-item" type="button" id="nav-templates" data-nav="templates"><span class="nav-icon">${icons.spark}</span>Templates</button>
      </nav>
      <div class="sidebar-bottom">
        <div class="storage-note"><span class="storage-line"></span><div><strong>Privacy mode</strong><span>Deletes after 24 h</span></div></div>
      </div>
    </aside>
    <main class="main-shell">
      <header class="topbar">
        <div class="crumbs"><span>Workspace</span><span class="crumb-rule"></span><strong>No manuscript loaded</strong></div>
        <div class="top-actions"><span class="secure-label">${icons.check} Local session</span></div>
      </header>
      <div class="workbench">
        <section class="workspace-column" aria-labelledby="page-title">
          <div class="page-heading">
            <div>
              <h1 id="page-title">Upload your manuscript</h1>
              <p>PaperForge converts DOCX to IEEE or ACM LaTeX while preserving your science and showing every step.</p>
            </div>
          </div>
          <section class="upload-zone" aria-label="Upload area">
            <div class="upload-icon">${icons.upload}</div>
            <h2>Choose a DOCX manuscript</h2>
            <p class="upload-limits">Accepted: <strong>.docx</strong> · Max <strong>25 MB</strong> · Up to <strong>50 pages</strong>, <strong>50 figures</strong>, <strong>30 tables</strong>, <strong>300 references</strong></p>
            <label class="primary-button" for="manuscript-input" id="upload-label">Select manuscript ${icons.arrow}</label>
            <input id="manuscript-input" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" aria-label="Select DOCX manuscript" hidden>
            <div class="upload-bib-row">
              <label class="bib-label" for="bib-input">${icons.bib} Optional bibliography (.bib file)</label>
              <input id="bib-input" type="file" accept=".bib,text/plain" aria-label="Select optional BibTeX file" hidden>
              <label class="bib-button" for="bib-input" id="bib-button-label">Choose .bib ${icons.arrow}</label>
              <span id="bib-name" class="bib-name"></span>
            </div>
            <label class="select-wrap" style="margin-top:12px">Output template<select id="target-select"><option>IEEEtran</option><option>acmart</option></select></label>
            <p class="upload-privacy">${icons.info} Files are deleted automatically after download (max 24 hours). Content is never used for training without consent.</p>
            <div class="demo-hint"><button class="text-button" id="demo-button" type="button">Try with demo data</button></div>
          </section>
        </section>
      </div>
    </main>
  `;
}

// ---------------------------------------------------------------------------
// Approval / consent gate banner
// ---------------------------------------------------------------------------
function renderGateBanner(label, description, actionId, actionLabel) {
  return `<div class="approval-banner" role="alert">
    <span class="banner-icon">${icons.info}</span>
    <div><strong>${label}</strong><p>${description}</p></div>
    <button class="primary-button" id="${actionId}" type="button">${actionLabel} ${icons.arrow}</button>
  </div>`;
}

// ---------------------------------------------------------------------------
// Diff viewer panel
// ---------------------------------------------------------------------------
function renderDiffPanel() {
  if (!showDiff || !diffData) return '';
  const orig = diffData.original ?? '';
  const rep = diffData.repaired ?? orig;
  const origLines = orig.split('\n');
  const repLines = rep.split('\n');
  const maxLen = Math.max(origLines.length, repLines.length);
  let rows = '';
  for (let i = 0; i < Math.min(maxLen, 200); i++) {
    const a = origLines[i] ?? '';
    const b = repLines[i] ?? '';
    const cls = a !== b ? 'diff-changed' : '';
    rows += `<tr class="${cls}"><td class="diff-ln">${i + 1}</td><td class="diff-before">${escHtml(a)}</td><td class="diff-ln">${i + 1}</td><td class="diff-after">${escHtml(b)}</td></tr>`;
  }
  return `
    <section class="diff-panel" aria-labelledby="diff-title">
      <div class="section-heading">
        <div><p class="section-label">Source diff</p><h2 id="diff-title">Before / After Repairs</h2></div>
        <button class="text-button" id="diff-close-button" type="button">Close diff</button>
      </div>
      <div class="diff-scroll">
        <table class="diff-table" aria-label="LaTeX source before and after repairs">
          <thead><tr><th colspan="2">Original</th><th colspan="2">Repaired</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Badge helper
// ---------------------------------------------------------------------------
function badge(label, tone) {
  return `<span class="status-badge ${tone}"><span class="status-dot"></span>${label}</span>`;
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------
function render() {
  if (!job) {
    appRoot.innerHTML = renderUploadPrompt();
    bindUploadEvents();
    return;
  }

  const findings = filterFindings(job.findings, findingFilter);
  const isAwaiting = job.status === 'awaiting-approval' || job.status === 'awaiting-image-consent';
  const isTerminal = ['ready', 'error', 'rolled-back', 'cancelled'].includes(job.status);

  const gateBanner = job.status === 'awaiting-approval'
    ? renderGateBanner('Approval required', 'A substantive finding requires your review before conversion continues.', 'approve-button', 'Approve and continue')
    : job.status === 'awaiting-image-consent'
    ? renderGateBanner('Image-heavy document detected', `${job.document?.figures ?? 'Many'} images detected. Assets cannot be embedded automatically. Confirm to proceed.`, 'consent-button', 'I understand — continue')
    : '';

  const statusLabel = job.status === 'ready' ? 'Ready for review'
    : job.status === 'rolled-back' ? 'Rolled back'
    : isAwaiting ? 'Awaiting approval'
    : job.status === 'error' ? 'Error — escalated'
    : 'In progress';

  const statusTone = job.status === 'ready' || job.status === 'rolled-back' ? 'success'
    : isAwaiting ? 'warning'
    : job.status === 'error' ? 'error'
    : 'active';

  const showRollback = isTerminal && job.real && (job.repairsUsed > 0) && job.status !== 'rolled-back';
  const hasDiffAvailable = job.real && (job.repairsUsed > 0 || (diffData && diffData.hasChanges));

  appRoot.innerHTML = `
    <aside class="sidebar" aria-label="Primary navigation">
      <div class="brand"><span class="brand-mark">P</span><span>PaperForge</span></div>
      <nav class="nav-list">
        <button class="nav-item active" type="button" id="nav-workspace" data-nav="workspace"><span class="nav-icon">${icons.file}</span>Workspace</button>
        <button class="nav-item" type="button" id="nav-templates" data-nav="templates"><span class="nav-icon">${icons.spark}</span>Templates</button>
        <button class="nav-item" type="button" id="nav-activity" data-nav="activity"><span class="nav-icon">${icons.arrow}</span>Activity</button>
      </nav>
      <div class="sidebar-bottom">
        <div class="storage-note"><span class="storage-line"></span><div><strong>Privacy mode</strong><span>Deletes after 24 h</span></div></div>
        <button class="nav-item" type="button" id="nav-settings" data-nav="settings"><span class="nav-icon">${icons.info}</span>Settings</button>
      </div>
    </aside>
    <main class="main-shell">
      <header class="topbar">
        <div class="crumbs"><span>Workspace</span><span class="crumb-rule"></span><strong>${job.filename}</strong></div>
        <div class="top-actions">
          <span class="secure-label">${icons.check} Local session</span>
          ${job.real && !isTerminal ? `<button class="icon-button" type="button" id="cancel-button" aria-label="Cancel job" title="Cancel this job">${icons.cancel}</button>` : ''}
        </div>
      </header>
      <div class="workbench">
        <section class="workspace-column" aria-labelledby="page-title">
          ${gateBanner}
          <div class="page-heading">
            <div>
              <h1 id="page-title">Conversion workspace</h1>
              <p>Keep your science intact. Shape the format with a clear audit trail.</p>
            </div>
            ${badge(statusLabel, statusTone)}
          </div>

          <section class="manuscript-strip" aria-label="Manuscript summary">
            <div class="manuscript-icon">${icons.file}</div>
            <div class="manuscript-meta"><strong>${job.filename}</strong><span>${job.size} · Uploaded just now</span></div>
            <div class="file-actions">
              <label class="replace-button" for="manuscript-input-replace">Replace manuscript</label>
              <input id="manuscript-input-replace" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" aria-label="Replace manuscript" hidden>
              <label class="select-wrap">Output template<select id="target-select"><option ${job.target === 'IEEEtran' ? 'selected' : ''}>IEEEtran</option><option ${job.target === 'acmart' ? 'selected' : ''}>acmart</option></select></label>
            </div>
          </section>

          <section class="intent-panel" aria-labelledby="intent-title">
            <div class="section-heading">
              <div><p class="section-label">Before we begin</p><h2 id="intent-title">Review the plan</h2></div>
              <span class="plan-id">Plan ${job.id}</span>
            </div>
            <p class="intent-copy">PaperForge will extract structure, map it to <strong>${job.target}</strong>, compile a draft, and check its references and assets. It will not rewrite scientific claims or invent bibliography entries.</p>
            <div class="intent-grid">
              <div><span>Data accessed</span><strong>Uploaded manuscript + bibliography</strong></div>
              <div><span>Allowed actions</span><strong>Format fixes required for compile</strong></div>
              <div><span>Human approval</span><strong>Content-affecting changes</strong></div>
            </div>
            <div class="intent-actions">
              <button class="primary-button" id="start-button" type="button" ${job.real && job.status === 'running' ? 'disabled' : ''}>
                ${job.real && job.status === 'running' ? 'Processing…' : job.status === 'intent' ? 'Start conversion' : job.status === 'ready' || job.status === 'rolled-back' ? 'Conversion complete' : isAwaiting ? 'Awaiting approval' : 'Advance demo'} ${icons.arrow}
              </button>
              <button class="text-button" id="reset-button" type="button">Start over</button>
              ${showRollback ? `<button class="text-button rollback-button" id="rollback-button" type="button">${icons.rollback} Roll back repairs</button>` : ''}
              ${hasDiffAvailable ? `<button class="text-button" id="diff-button" type="button">${icons.diff} ${showDiff ? 'Hide diff' : 'View diff'}</button>` : ''}
            </div>
          </section>

          ${renderDiffPanel()}

          <section class="ledger-section" aria-labelledby="ledger-title">
            <div class="section-heading">
              <div><p class="section-label">Progress ledger</p><h2 id="ledger-title">What PaperForge is doing</h2></div>
              <span class="progress-value">${job.progress}%</span>
            </div>
            <div class="progress-track"><span style="width:${job.progress}%"></span></div>
            <div class="ledger">${stages.map(renderLedger).join('')}</div>
          </section>

          <section class="report-section" aria-labelledby="report-title">
            <div class="section-heading">
              <div><p class="section-label">Outcome verification</p><h2 id="report-title">Validation report</h2></div>
              <div class="filter-group" role="group" aria-label="Filter findings">
                ${['all', 'error', 'warning', 'pass'].map((f) => `<button class="filter-button ${findingFilter === f ? 'selected' : ''}" type="button" data-filter="${f}" id="filter-${f}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}
              </div>
            </div>
            <div class="report-summary">
              <div><strong>${job.findings.filter((x) => x.severity === 'pass').length}</strong><span>passed checks</span></div>
              <div><strong>${job.findings.filter((x) => x.severity === 'warning').length}</strong><span>review notes</span></div>
              <div><strong>${job.findings.filter((x) => x.severity === 'error').length}</strong><span>blocking issues</span></div>
            </div>
            <div class="findings-list">${findings.map(renderFinding).join('')}</div>
          </section>
        </section>

        <aside class="detail-rail" aria-label="Job details">
          <div class="rail-heading"><span>Job details</span></div>
          <div class="rail-block">
            <span class="rail-label">Current state</span>
            <strong>${job.stage === 'Ready' ? 'Ready for review' : job.stage}</strong>
            <span class="rail-muted">Updated just now</span>
          </div>
          <div class="rail-block">
            <span class="rail-label">Content inventory</span>
            <dl class="inventory">
              <div><dt>Figures</dt><dd>${job.figures}</dd></div>
              <div><dt>Tables</dt><dd>${job.tables}</dd></div>
              <div><dt>References</dt><dd>${job.references}</dd></div>
            </dl>
          </div>
          <div class="rail-block">
            <span class="rail-label">Repair budget</span>
            <div class="repair-count"><strong>${job.repairsUsed}</strong><span>/ 3 attempts used</span></div>
            <div class="mini-track"><span style="width:${(job.repairsUsed / 3) * 100}%"></span></div>
            <p class="rail-muted">Formatting repairs stay bounded. Meaningful edits pause for you.</p>
          </div>
          <div class="rail-block outputs">
            <span class="rail-label">Your outputs</span>
            ${renderOutput('Editable LaTeX source', 'source', job.outputs.source)}
            ${renderOutput('Compiled PDF', 'pdf', job.outputs.pdf)}
            ${renderOutput('Validation report', 'report', job.outputs.report)}
            ${renderOutput('Change log', 'changelog', job.outputs.changelog)}
          </div>
          ${job.reasoning ? renderReasoning(job.reasoning) : ''}
          <div class="approval-note">
            <span class="note-icon">${icons.info}</span>
            <p><strong>Human in the loop</strong>PaperForge never changes claims, data, or authorship without your approval.</p>
          </div>
        </aside>
      </div>
    </main>
  `;
  bindEvents();
}

// ---------------------------------------------------------------------------
// Reasoning summary block (in rail)
// ---------------------------------------------------------------------------
function renderReasoning(r) {
  if (!r || !r.summary) return '';
  return `<div class="rail-block reasoning-block">
    <span class="rail-label">Agent review <small>(${r.provider ?? 'rule-based'})</small></span>
    <p class="reasoning-summary">${escHtml(r.summary)}</p>
    ${r.approvalRequired?.length ? `<p class="rail-muted"><strong>Needs review:</strong> ${r.approvalRequired.map(escHtml).join('; ')}</p>` : ''}
  </div>`;
}

// ---------------------------------------------------------------------------
// Ledger row
// ---------------------------------------------------------------------------
function renderLedger(stage) {
  const index = stages.indexOf(stage);
  const activeIndex = stages.indexOf(job.stage ?? 'Thinking');
  const state = index < activeIndex ? 'complete' : index === activeIndex ? 'current' : 'upcoming';
  const entry = job.ledger?.find((item) => item.stage === stage);
  return `<div class="ledger-row ${state}" role="listitem">
    <span class="ledger-marker">${state === 'complete' ? icons.check : index + 1}</span>
    <div class="ledger-copy"><strong>${stage}</strong><span>${entry?.label ?? 'Waiting for previous stage'}</span></div>
    <span class="ledger-status">${state === 'complete' ? 'Done' : state === 'current' ? 'Now' : 'Queued'}</span>
  </div>`;
}

// ---------------------------------------------------------------------------
// Finding row
// ---------------------------------------------------------------------------
function renderFinding(finding) {
  const tone = finding.severity === 'pass' ? 'success' : finding.severity;
  const needsApproval = finding.approval && finding.severity !== 'pass';
  return `<article class="finding-row">
    <div class="finding-icon ${tone}">${finding.severity === 'pass' ? icons.check : icons.info}</div>
    <div class="finding-copy">
      <div class="finding-title">
        <strong>${escHtml(finding.title ?? finding.rule)}</strong>
        ${badge(finding.severity === 'pass' ? 'Passed' : finding.severity, tone)}
        ${needsApproval ? badge('Approval required', 'warning') : ''}
      </div>
      <p>${escHtml(finding.detail ?? '')}</p>
      <div class="finding-meta">
        <span>${escHtml(finding.rule)}</span>
        ${finding.location ? `<span>${escHtml(finding.location)}</span>` : ''}
        <span>${Math.round((finding.confidence ?? 0) * 100)}% confidence</span>
      </div>
    </div>
    <button class="icon-button finding-action" type="button" aria-label="View rationale for ${escHtml(finding.rule)}" data-finding="${finding.id ?? finding.rule}">${icons.arrow}</button>
  </article>`;
}

// ---------------------------------------------------------------------------
// Output row
// ---------------------------------------------------------------------------
function renderOutput(label, key, available) {
  return `<button class="output-row ${available ? 'available' : 'locked'}" type="button" id="output-${key}" data-output="${key}" ${available ? '' : 'disabled'} aria-label="${available ? 'Download ' : 'Unavailable: '}${label}">
    <span>${available ? icons.download : icons.file}</span>
    <strong>${label}</strong>
    <small>${available ? 'Download' : 'Available when ready'}</small>
  </button>`;
}

// ---------------------------------------------------------------------------
// Upload state: selected bib file ref
// ---------------------------------------------------------------------------
let selectedBibFile = null;

function bindUploadEvents() {
  document.querySelector('#manuscript-input')?.addEventListener('change', handleManuscriptChange);
  document.querySelector('#bib-input')?.addEventListener('change', (e) => {
    selectedBibFile = e.target.files?.[0] ?? null;
    const nameEl = document.querySelector('#bib-name');
    if (nameEl) nameEl.textContent = selectedBibFile ? selectedBibFile.name : '';
    announce(selectedBibFile ? `Bibliography file selected: ${selectedBibFile.name}` : 'Bibliography file cleared.');
  });
  document.querySelector('#demo-button')?.addEventListener('click', () => {
    job = createDemoJob(); findingFilter = 'all'; diffData = null; showDiff = false;
    announce('Demo job loaded.');
    render();
  });
}

// ---------------------------------------------------------------------------
// Upload handler
// ---------------------------------------------------------------------------
async function handleManuscriptChange(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const isDocx = file.name.toLowerCase().endsWith('.docx');
  if (!isDocx || file.size > 25 * 1024 * 1024) {
    announce(!isDocx ? 'File rejected. Choose a DOCX manuscript.' : 'File rejected. DOCX files must be 25 megabytes or smaller.');
    return;
  }
  const targetEl = document.querySelector('#target-select');
  const form = new FormData();
  form.append('manuscript', file);
  form.append('target', targetEl?.value ?? 'IEEEtran');
  if (selectedBibFile) form.append('bibliography', selectedBibFile);

  announce(`${file.name} uploaded. Extracting structure.`);
  try {
    const response = await fetch('/api/jobs', { method: 'POST', body: form });
    if (!response.ok) throw new Error((await response.json()).error || 'Upload failed.');
    const serverJob = await response.json();
    job = normalizeServerJob(serverJob);
    diffData = null; showDiff = false;
    render();
    connectSSE(serverJob.id); // switch to SSE for real-time updates
  } catch (error) {
    announce(error.message);
  }
}

// ---------------------------------------------------------------------------
// Event binding
// ---------------------------------------------------------------------------
function bindEvents() {
  // Replace manuscript
  document.querySelector('#manuscript-input-replace')?.addEventListener('change', handleManuscriptChange);

  // Target change (demo only — real job already submitted)
  document.querySelector('#target-select')?.addEventListener('change', (e) => {
    if (!job.real) { job = { ...job, target: e.target.value }; announce(`Target template changed to ${e.target.value}.`); render(); }
  });

  // Start / advance demo
  document.querySelector('#start-button')?.addEventListener('click', () => {
    if (job.real) {
      if (job.status === 'running') { announce('Conversion is running. Updates will arrive automatically.'); return; }
      announce(job.status === 'ready' || job.status === 'rolled-back' ? 'Conversion is complete and ready for review.' : 'Awaiting your approval before continuing.');
      return;
    }
    if (job.status === 'ready') { announce('Conversion is complete and ready for review.'); return; }
    job = advanceJob(job); announce(`${job.stage} stage active.`); render();
  });

  // Reset
  document.querySelector('#reset-button')?.addEventListener('click', () => {
    if (sseController) { sseController.abort(); sseController = null; }
    job = null; findingFilter = 'all'; diffData = null; showDiff = false;
    announce('Workspace reset. Upload a manuscript to begin.');
    render();
  });

  // Cancel job
  document.querySelector('#cancel-button')?.addEventListener('click', async () => {
    if (!job?.real) return;
    if (!confirm('Cancel this job? All conversion artifacts will be deleted.')) return;
    try {
      await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
      announce('Job cancelled.');
    } catch { announce('Failed to cancel job.'); }
  });

  // Approve
  document.querySelector('#approve-button')?.addEventListener('click', async () => {
    if (!job?.real) return;
    try {
      await fetch(`/api/jobs/${job.id}/approve`, { method: 'POST' });
      announce('Approval sent. Conversion resuming.');
    } catch { announce('Failed to send approval.'); }
  });

  // Consent (image-heavy)
  document.querySelector('#consent-button')?.addEventListener('click', async () => {
    if (!job?.real) return;
    try {
      await fetch(`/api/jobs/${job.id}/consent`, { method: 'POST' });
      announce('Consent recorded. Extraction resuming.');
    } catch { announce('Failed to send consent.'); }
  });

  // Rollback
  document.querySelector('#rollback-button')?.addEventListener('click', async () => {
    if (!job?.real) return;
    if (!confirm('Roll back to pre-repair LaTeX source? This will overwrite the repaired paper.tex.')) return;
    try {
      const r = await fetch(`/api/jobs/${job.id}/rollback`, { method: 'POST' });
      const body = await r.json();
      announce(body.message ?? 'Rolled back.');
      const refreshed = await fetch(`/api/jobs/${job.id}`);
      job = normalizeServerJob(await refreshed.json());
      render();
    } catch { announce('Rollback failed.'); }
  });

  // Diff toggle
  document.querySelector('#diff-button')?.addEventListener('click', async () => {
    showDiff = !showDiff;
    if (showDiff && !diffData && job?.real) {
      try {
        const r = await fetch(`/api/jobs/${job.id}/diff`);
        if (r.ok) diffData = await r.json();
      } catch { /* ignore */ }
    }
    render();
  });

  // Diff close
  document.querySelector('#diff-close-button')?.addEventListener('click', () => { showDiff = false; render(); });

  // Finding filters
  document.querySelectorAll('[data-filter]').forEach((btn) =>
    btn.addEventListener('click', () => { findingFilter = btn.dataset.filter; render(); }));

  // Finding detail
  document.querySelectorAll('[data-finding]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const finding = job.findings.find((f) => (f.id ?? f.rule) === btn.dataset.finding);
      if (finding) announce(`${finding.rule}: ${finding.detail} ${finding.approval ? 'Approval required.' : ''}`);
    }));

  // Outputs
  document.querySelectorAll('[data-output]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const output = btn.dataset.output;
      if (job.real) {
        const a = document.createElement('a');
        a.href = `/api/jobs/${job.id}/output/${output}`;
        a.download = '';
        a.rel = 'noopener';
        a.click();
      }
      announce(`${btn.querySelector('strong')?.textContent} download requested.`);
    }));

  // Nav
  document.querySelectorAll('[data-nav]').forEach((btn) =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-nav]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      announce(`${btn.textContent.trim()} selected.`);
    }));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
render();
