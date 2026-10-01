import { advanceJob, createDemoJob, filterFindings, stages } from './state.js';

const icons = {
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h5M9 13h6M9 17h6"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 10v6M12 7h.01"/></svg>',
  spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 14 9l6 2-6 2-2 6-2-6-6-2 6-2z"/></svg>',
  upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V9M7 14l5-5 5 5M5 20h14"/></svg>',
};

// Start with no job — real upload required (FR-001, US1/AC1)
let job = null;
let findingFilter = 'all';

function normalizeServerJob(serverJob) {
  return { ...createDemoJob(), ...serverJob, real: true, size: typeof serverJob.size === 'number' ? `${(serverJob.size / 1024 / 1024).toFixed(1)} MB` : serverJob.size, figures: serverJob.document?.figures ?? 0, tables: serverJob.document?.tables ?? 0, references: serverJob.document?.references ?? 0, findings: serverJob.findings ?? [], outputs: { source: Boolean(serverJob.document), pdf: Boolean(serverJob.compile?.pdf), report: Boolean(serverJob.document), changelog: Boolean(serverJob.document) } };
}

async function watchServerJob(id) {
  const response = await fetch(`/api/jobs/${id}`);
  if (!response.ok) return;
  const serverJob = await response.json(); job = normalizeServerJob(serverJob); render();
  if (!['ready', 'error'].includes(serverJob.status)) window.setTimeout(() => watchServerJob(id), 900);
}

const root = document.querySelector('#app');
const announce = (message) => { document.querySelector('#live-region').textContent = message; };
function renderUploadPrompt() {
  return `
    <aside class="sidebar" aria-label="Primary navigation">
      <div class="brand"><span class="brand-mark">P</span><span>PaperForge</span></div>
      <nav class="nav-list">
        <button class="nav-item active" type="button" data-nav="workspace"><span class="nav-icon">${icons.file}</span>Workspace</button>
        <button class="nav-item" type="button" data-nav="templates"><span class="nav-icon">${icons.spark}</span>Templates</button>
      </nav>
      <div class="sidebar-bottom">
        <div class="storage-note"><span class="storage-line"></span><div><strong>Privacy mode</strong><span>Deletes after download</span></div></div>
      </div>
    </aside>
    <main class="main-shell">
      <header class="topbar">
        <div class="crumbs"><span>Workspace</span><span class="crumb-rule"></span><strong>No manuscript loaded</strong></div>
        <div class="top-actions"><span class="secure-label">${icons.check} Local session</span></div>
      </header>
      <div class="workbench">
        <section class="workspace-column" aria-labelledby="page-title">
          <div class="page-heading"><div><h1 id="page-title">Upload your manuscript</h1><p>PaperForge converts DOCX to IEEE or ACM LaTeX while preserving your science and showing every step.</p></div></div>
          <section class="upload-zone" aria-label="Upload area">
            <div class="upload-icon">${icons.upload}</div>
            <h2>Choose a DOCX manuscript</h2>
            <p class="upload-limits">Accepted: <strong>.docx</strong> · Max <strong>25 MB</strong> · Up to <strong>50 pages</strong>, <strong>50 figures</strong>, <strong>30 tables</strong>, <strong>300 references</strong></p>
            <label class="primary-button" for="manuscript-input">Select manuscript ${icons.arrow}</label>
            <input id="manuscript-input" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden>
            <label class="select-wrap" style="margin-top:12px">Output template<select id="target-select"><option>IEEEtran</option><option>acmart</option></select></label>
            <p class="upload-privacy">${icons.info} Files are deleted automatically after download (max 24 hours). Content is never used for training without consent.</p>
            <div class="demo-hint"><button class="text-button" id="demo-button" type="button">Try with demo data</button></div>
          </section>
        </section>
      </div>
    </main>
  `;
}

function renderGateBanner(label, description, actionId, actionLabel) {
  return `<div class="approval-banner" role="alert">
    <span class="banner-icon">${icons.info}</span>
    <div><strong>${label}</strong><p>${description}</p></div>
    <button class="primary-button" id="${actionId}" type="button">${actionLabel} ${icons.arrow}</button>
  </div>`;
}

function render() {
  if (!job) { root.innerHTML = renderUploadPrompt(); bindUploadEvents(); return; }

  const findings = filterFindings(job.findings, findingFilter);
  const isAwaiting = job.status === 'awaiting-approval' || job.status === 'awaiting-image-consent';
  const gateBanner = job.status === 'awaiting-approval'
    ? renderGateBanner('Approval required', 'A substantive finding requires your review before conversion continues.', 'approve-button', 'Approve and continue')
    : job.status === 'awaiting-image-consent'
    ? renderGateBanner('Image-heavy document detected', `${job.document?.figures ?? 'Many'} images detected. Assets cannot be embedded automatically. Review and confirm to continue.`, 'consent-button', 'I understand — continue')
    : '';

  root.innerHTML = `
    <aside class="sidebar" aria-label="Primary navigation">
      <div class="brand"><span class="brand-mark">P</span><span>PaperForge</span></div>
      <nav class="nav-list">
        <button class="nav-item active" type="button" data-nav="workspace"><span class="nav-icon">${icons.file}</span>Workspace</button>
        <button class="nav-item" type="button" data-nav="templates"><span class="nav-icon">${icons.spark}</span>Templates</button>
        <button class="nav-item" type="button" data-nav="activity"><span class="nav-icon">${icons.arrow}</span>Activity</button>
      </nav>
      <div class="sidebar-bottom">
        <div class="storage-note"><span class="storage-line"></span><div><strong>Privacy mode</strong><span>Deletes after download</span></div></div>
        <button class="nav-item" type="button" data-nav="settings"><span class="nav-icon">${icons.info}</span>Settings</button>
        <div class="profile"><span class="avatar">AM</span><span><strong>Alex Morgan</strong><small>Research lab</small></span></div>
      </div>
    </aside>
    <main class="main-shell">
      <header class="topbar">
        <div class="crumbs"><span>Workspace</span><span class="crumb-rule"></span><strong>${job.filename}</strong></div>
        <div class="top-actions"><span class="secure-label">${icons.check} Local session</span><button class="icon-button" type="button" aria-label="Open help">${icons.info}</button></div>
      </header>
      <div class="workbench">
        <section class="workspace-column" aria-labelledby="page-title">
          ${gateBanner}
          <div class="page-heading"><div><h1 id="page-title">Conversion workspace</h1><p>Keep your science intact. Shape the format with a clear audit trail.</p></div>${badge(job.status === 'ready' ? 'Ready for review' : isAwaiting ? 'Awaiting approval' : 'In progress', job.status === 'ready' ? 'success' : isAwaiting ? 'warning' : 'active')}</div>
          <section class="manuscript-strip" aria-label="Manuscript summary">
            <div class="manuscript-icon">${icons.file}</div><div class="manuscript-meta"><strong>${job.filename}</strong><span>${job.size} · Uploaded just now</span></div>
            <div class="file-actions"><label class="replace-button" for="manuscript-input">Replace manuscript</label><input id="manuscript-input" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden><label class="select-wrap">Output template<select id="target-select"><option ${job.target === 'IEEEtran' ? 'selected' : ''}>IEEEtran</option><option ${job.target === 'acmart' ? 'selected' : ''}>acmart</option></select></label></div>
          </section>
          <section class="intent-panel" aria-labelledby="intent-title">
            <div class="section-heading"><div><p class="section-label">Before we begin</p><h2 id="intent-title">Review the plan</h2></div><span class="plan-id">Plan ${job.id}</span></div>
            <p class="intent-copy">PaperForge will extract structure, map it to <strong>${job.target}</strong>, compile a draft, and check its references and assets. It will not rewrite scientific claims or invent bibliography entries.</p>
            <div class="intent-grid"><div><span>Data accessed</span><strong>Uploaded manuscript + bibliography</strong></div><div><span>Allowed actions</span><strong>Format fixes required for compile</strong></div><div><span>Human approval</span><strong>Content-affecting changes</strong></div></div>
            <div class="intent-actions"><button class="primary-button" id="start-button" type="button">${job.real && job.status === 'running' ? 'Processing manuscript' : job.status === 'intent' ? 'Start conversion' : job.status === 'ready' ? 'Conversion complete' : isAwaiting ? 'Awaiting approval' : 'Advance demo job'} ${icons.arrow}</button><button class="text-button" id="reset-button" type="button">Start over</button></div>
          </section>
          <section class="ledger-section" aria-labelledby="ledger-title"><div class="section-heading"><div><p class="section-label">Progress ledger</p><h2 id="ledger-title">What PaperForge is doing</h2></div><span class="progress-value">${job.progress}%</span></div><div class="progress-track"><span style="width:${job.progress}%"></span></div><div class="ledger">${stages.map((stage) => renderLedger(stage)).join('')}</div></section>
          <section class="report-section" aria-labelledby="report-title"><div class="section-heading"><div><p class="section-label">Outcome verification</p><h2 id="report-title">Validation report</h2></div><div class="filter-group" role="group" aria-label="Filter findings">${['all', 'error', 'warning', 'pass'].map((filter) => `<button class="filter-button ${findingFilter === filter ? 'selected' : ''}" type="button" data-filter="${filter}">${filter[0].toUpperCase() + filter.slice(1)}</button>`).join('')}</div></div><div class="report-summary"><div><strong>${job.findings.filter((item) => item.severity === 'pass').length}</strong><span>passed checks</span></div><div><strong>${job.findings.filter((item) => item.severity === 'warning').length}</strong><span>review notes</span></div><div><strong>${job.findings.filter((item) => item.severity === 'error').length}</strong><span>blocking issues</span></div></div><div class="findings-list">${findings.map(renderFinding).join('')}</div></section>
        </section>
        <aside class="detail-rail" aria-label="Job details">
          <div class="rail-heading"><span>Job details</span><button class="icon-button" type="button" aria-label="More job actions">${icons.info}</button></div>
          <div class="rail-block"><span class="rail-label">Current state</span><strong>${job.stage === 'Ready' ? 'Ready for review' : job.stage}</strong><span class="rail-muted">Updated just now</span></div>
          <div class="rail-block"><span class="rail-label">Content inventory</span><dl class="inventory"><div><dt>Figures</dt><dd>${job.figures}</dd></div><div><dt>Tables</dt><dd>${job.tables}</dd></div><div><dt>References</dt><dd>${job.references}</dd></div></dl></div>
          <div class="rail-block"><span class="rail-label">Repair budget</span><div class="repair-count"><strong>${job.repairsUsed}</strong><span>/ 3 attempts used</span></div><div class="mini-track"><span style="width:${job.repairsUsed / 3 * 100}%"></span></div><p class="rail-muted">Formatting repairs stay bounded. Meaningful edits pause for you.</p></div>
          <div class="rail-block outputs"><span class="rail-label">Your outputs</span>${renderOutput('Editable LaTeX source', 'source', job.outputs.source)}${renderOutput('Compiled PDF', 'pdf', job.outputs.pdf)}${renderOutput('Validation report', 'report', job.outputs.report)}${renderOutput('Change log', 'changelog', job.outputs.changelog)}</div>
          <div class="approval-note"><span class="note-icon">${icons.info}</span><p><strong>Human in the loop</strong>PaperForge never changes claims, data, or authorship without your approval.</p></div>
        </aside>
      </div>
    </main>
  `;
  bindEvents();
}

function renderLedger(stage) {
  const index = stages.indexOf(stage); const activeIndex = stages.indexOf(job.stage);
  const state = index < activeIndex ? 'complete' : index === activeIndex ? 'current' : 'upcoming';
  const entry = job.ledger.find((item) => item.stage === stage);
  return `<div class="ledger-row ${state}"><span class="ledger-marker">${state === 'complete' ? icons.check : index + 1}</span><div class="ledger-copy"><strong>${stage}</strong><span>${entry?.label ?? 'Waiting for previous stage'}</span></div><span class="ledger-status">${state === 'complete' ? 'Done' : state === 'current' ? 'Now' : 'Queued'}</span></div>`;
}

function renderFinding(finding) {
  const tone = finding.severity === 'pass' ? 'success' : finding.severity;
  return `<article class="finding-row"><div class="finding-icon ${tone}">${finding.severity === 'pass' ? icons.check : icons.info}</div><div class="finding-copy"><div class="finding-title"><strong>${finding.title}</strong>${badge(finding.severity === 'pass' ? 'Passed' : finding.severity, tone)}</div><p>${finding.detail}</p><div class="finding-meta"><span>${finding.rule}</span><span>${finding.location ?? ''}</span><span>${Math.round((finding.confidence ?? 0) * 100)}% confidence</span></div></div><button class="icon-button finding-action" type="button" aria-label="View rationale for ${finding.id ?? ''}" data-finding="${finding.id ?? ''}">${icons.arrow}</button></article>`;
}

function renderOutput(label, key, available) {
  return `<button class="output-row ${available ? 'available' : 'locked'}" type="button" data-output="${key}" ${available ? '' : 'disabled'}><span>${available ? icons.download : icons.file}</span><strong>${label}</strong><small>${available ? 'Download' : 'Available when ready'}</small></button>`;
}

function bindUploadEvents() {
  document.querySelector('#manuscript-input').addEventListener('change', handleManuscriptChange);
  document.querySelector('#demo-button').addEventListener('click', () => { job = createDemoJob(); findingFilter = 'all'; announce('Demo job loaded.'); render(); });
}

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
  announce(`${file.name} uploaded. Extracting structure.`);
  try {
    const response = await fetch('/api/jobs', { method: 'POST', body: form });
    if (!response.ok) throw new Error((await response.json()).error || 'Upload failed.');
    const serverJob = await response.json();
    job = normalizeServerJob(serverJob);
    render();
    watchServerJob(serverJob.id);
  } catch (error) {
    announce(error.message);
  }
}

function bindEvents() {
  document.querySelector('#manuscript-input')?.addEventListener('change', handleManuscriptChange);
  document.querySelector('#target-select')?.addEventListener('change', (event) => { job = { ...job, target: event.target.value }; announce(`Target template changed to ${event.target.value}.`); render(); });
  document.querySelector('#start-button')?.addEventListener('click', () => {
    if (job.real) { announce(job.status === 'ready' ? 'Conversion is complete and ready for review.' : 'Conversion is running on the server.'); if (job.status === 'running') watchServerJob(job.id); return; }
    if (job.status === 'ready') { announce('Conversion is complete and ready for review.'); return; }
    if (job.status === 'awaiting-approval' || job.status === 'awaiting-image-consent') { announce('Awaiting your approval before continuing.'); return; }
    job = advanceJob(job); announce(`${job.stage} stage active.`); render();
  });
  document.querySelector('#reset-button')?.addEventListener('click', () => { job = null; findingFilter = 'all'; announce('Workspace reset. Upload a manuscript to begin.'); render(); });
  document.querySelector('#approve-button')?.addEventListener('click', async () => {
    if (!job?.real) return;
    await fetch(`/api/jobs/${job.id}/approve`, { method: 'POST' });
    announce('Approval sent. Conversion resuming.'); watchServerJob(job.id);
  });
  document.querySelector('#consent-button')?.addEventListener('click', async () => {
    if (!job?.real) return;
    await fetch(`/api/jobs/${job.id}/consent`, { method: 'POST' });
    announce('Consent recorded. Extraction resuming.'); watchServerJob(job.id);
  });
  document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { findingFilter = button.dataset.filter; render(); }));
  document.querySelectorAll('[data-finding]').forEach((button) => button.addEventListener('click', () => { const finding = job.findings.find((item) => item.id === button.dataset.finding); if (finding) announce(`${finding.id ?? ''}: ${finding.detail} ${finding.approval ? 'Approval required.' : ''}`); }));
  document.querySelectorAll('[data-output]').forEach((button) => button.addEventListener('click', () => { const output = button.dataset.output; if (job.real) window.open(`/api/jobs/${job.id}/output/${output}`, '_blank', 'noopener'); announce(`${button.querySelector('strong').textContent} download requested.`); }));
  document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('[data-nav]').forEach((item) => item.classList.remove('active')); button.classList.add('active'); announce(`${button.textContent.trim()} selected.`); }));
}

render();



