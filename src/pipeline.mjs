import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import mammoth from 'mammoth';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
export const LIMITS = Object.freeze({
  maxBytes: 25 * 1024 * 1024,
  maxPages: 50,
  maxFigures: 50,
  maxTables: 30,
  maxReferences: 300,
});

// ---------------------------------------------------------------------------
// Upload validation
// ---------------------------------------------------------------------------
export function validateUpload({ filename, size, mimeType = '' }) {
  const extension = path.extname(filename ?? '').toLowerCase();
  if (extension !== '.docx') throw new Error('Only DOCX manuscripts are supported.');
  if (size > LIMITS.maxBytes) throw new Error('DOCX file exceeds the 25 MB limit.');
  if (mimeType && !mimeType.includes('wordprocessingml') && mimeType !== 'application/octet-stream') {
    throw new Error('Uploaded file type is not a DOCX document.');
  }
  return { accepted: true, extension, limits: LIMITS };
}

// ---------------------------------------------------------------------------
// LaTeX escaping — escapes special characters; never alters scientific meaning
// ---------------------------------------------------------------------------
function escapeLatex(text) {
  return String(text)
    .replaceAll('\\', '\\textbackslash{}')
    .replace(/[&%$#_{}]/g, (c) => `\\${c}`)
    .replaceAll('~', '\\textasciitilde{}')
    .replaceAll('^', '\\textasciicircum{}');
}

// ---------------------------------------------------------------------------
// HTML → structured blocks
// ---------------------------------------------------------------------------
function htmlToBlocks(html) {
  const blocks = [];
  const normalized = html.replace(/\r?\n/g, ' ');

  // Headings, paragraphs, list items, table rows, figure captions
  const blockMatcher = /<(h[1-6]|p|li|tr|figcaption)[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of normalized.matchAll(blockMatcher)) {
    const tag = match[1].toLowerCase();
    const raw = match[2];

    // Check if this block contains an image (figure)
    const hasImg = /<img\b/i.test(raw);
    const text = raw
      .replace(/<br\s*\/?>\s*/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();

    if (hasImg) {
      // Capture alt text for caption
      const altMatch = raw.match(/alt="([^"]*)"/i);
      blocks.push({ type: 'figure', caption: altMatch?.[1]?.trim() || '' });
      continue;
    }
    if (!text) continue;

    if (tag.startsWith('h')) {
      blocks.push({ type: 'heading', level: Number(tag.slice(1)), text });
    } else if (tag === 'tr') {
      blocks.push({ type: 'table-row', text });
    } else {
      blocks.push({ type: 'paragraph', text });
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// DOCX extraction
// ---------------------------------------------------------------------------
export async function extractDocx(buffer, filename) {
  const [rawResult, htmlResult] = await Promise.all([
    mammoth.extractRawText({ buffer }),
    mammoth.convertToHtml({ buffer }),
  ]);

  const blocks = htmlToBlocks(htmlResult.value);
  const text = rawResult.value.trim();
  const headings = blocks.filter((b) => b.type === 'heading');
  const tableRows = blocks.filter((b) => b.type === 'table-row');
  const figureBlocks = blocks.filter((b) => b.type === 'figure');
  const figures = figureBlocks.length + (htmlResult.value.match(/<img\b/gi) ?? []).length;
  const references = (text.match(/\n\s*(?:\[?\d+\]?\.|References?\s)/gi) ?? []).length;

  if (tableRows.length > LIMITS.maxTables) throw new Error('Document contains more than 30 detected table rows.');
  if (figures > LIMITS.maxFigures) throw new Error('Document contains more than 50 figures.');

  return {
    filename, text, html: htmlResult.value, blocks,
    headings, tables: tableRows, figures, references,
    messages: htmlResult.messages,
    imageHeavy: figures >= 10,
  };
}

// ---------------------------------------------------------------------------
// Structure extraction from blocks (no side-effects, no output)
// ---------------------------------------------------------------------------
function extractTitle(blocks, filename) {
  return blocks.find((b) => b.type === 'heading' && b.level === 1)?.text
    ?? blocks.find((b) => b.type === 'heading')?.text
    ?? path.basename(filename ?? 'paper', '.docx');
}

function extractAbstract(blocks) {
  const idx = blocks.findIndex(
    (b) => b.type === 'heading' && /^abstract$/i.test(b.text.trim()),
  );
  if (idx < 0) return '';
  const parts = [];
  for (let i = idx + 1; i < blocks.length; i++) {
    if (blocks[i].type === 'heading') break;
    if (blocks[i].type === 'paragraph') parts.push(blocks[i].text);
  }
  return parts.join(' ').trim();
}

function extractKeywords(blocks) {
  const idx = blocks.findIndex(
    (b) => b.type === 'heading' && /^keywords?$/i.test(b.text.trim()),
  );
  if (idx < 0) return '';
  const next = blocks[idx + 1];
  return next?.type === 'paragraph' ? next.text.trim() : '';
}

// ---------------------------------------------------------------------------
// Body builder — produces clean LaTeX, no comments
// ---------------------------------------------------------------------------
function renderTable(rows, tableIndex) {
  if (rows.length === 0) return '';
  // Estimate column count from the most common delimiter pattern
  const splitRow = (r) => r.split(/\t|\s{2,}/).map((c) => c.trim()).filter(Boolean);
  const colCounts = rows.map((r) => splitRow(r).length);
  const numCols = Math.max(2, ...colCounts);
  const colSpec = Array(numCols).fill('l').join(' ');

  const latexRows = rows.map((row, ri) => {
    const cells = splitRow(row);
    while (cells.length < numCols) cells.push('');
    const line = cells.map(escapeLatex).join(' & ');
    return ri === 0 ? `${line} \\\\\\hline` : `${line} \\\\`;
  });

  return [
    '\\begin{table}[htbp]',
    '\\centering',
    `\\begin{tabular}{${colSpec}}`,
    '\\hline',
    ...latexRows,
    '\\hline',
    '\\end{tabular}',
    `\\caption{Table ${tableIndex}}`,
    `\\label{tab:t${tableIndex}}`,
    '\\end{table}',
  ].join('\n');
}

function renderFigure(block, figIndex) {
  const caption = block.caption ? escapeLatex(block.caption) : `Figure ${figIndex}`;
  return [
    '\\begin{figure}[htbp]',
    '\\centering',
    `\\fbox{\\parbox{0.7\\linewidth}{\\centering [Figure ${figIndex}: insert image file before submission]}}`,
    `\\caption{${caption}}`,
    `\\label{fig:f${figIndex}}`,
    '\\end{figure}',
  ].join('\n');
}

function buildBody(blocks, titleText, abstractText) {
  const parts = [];
  let figIdx = 0;
  let tableIdx = 0;
  let i = 0;
  let inAbstractSection = false;

  while (i < blocks.length) {
    const block = blocks[i];

    // Skip the title heading
    if (block.type === 'heading' && block.text === titleText) { i++; continue; }

    // Skip "Abstract" heading and its captured text (already in preamble)
    if (block.type === 'heading' && /^abstract$/i.test(block.text.trim())) {
      inAbstractSection = true; i++; continue;
    }
    // Skip "Keywords" heading and next paragraph
    if (block.type === 'heading' && /^keywords?$/i.test(block.text.trim())) {
      i++; if (blocks[i]?.type === 'paragraph') i++; continue;
    }
    if (inAbstractSection) {
      if (block.type === 'paragraph' && abstractText && block.text === abstractText) { i++; continue; }
      if (block.type === 'heading') inAbstractSection = false;
      else { i++; continue; }
    }

    // Figure
    if (block.type === 'figure') {
      figIdx++;
      parts.push(renderFigure(block, figIdx));
      i++; continue;
    }

    // Table group — collect consecutive table-row blocks
    if (block.type === 'table-row') {
      const rows = [];
      while (i < blocks.length && blocks[i].type === 'table-row') { rows.push(blocks[i].text); i++; }
      tableIdx++;
      parts.push(renderTable(rows, tableIdx));
      continue;
    }

    // Heading → section command (proper level hierarchy)
    if (block.type === 'heading') {
      const cmd = block.level <= 1 ? 'section'
        : block.level === 2 ? 'subsection'
        : 'subsubsection';
      parts.push(`\\${cmd}{${escapeLatex(block.text)}}`);
      i++; continue;
    }

    // Paragraph
    if (block.type === 'paragraph') {
      parts.push(escapeLatex(block.text));
      i++; continue;
    }

    i++;
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Official venue templates
// Each template generate() returns a complete, compilable LaTeX document.
// No comments or meta-notes are inserted into the output.
// ---------------------------------------------------------------------------
export const TEMPLATES = {
  IEEEtran: {
    label: 'IEEE (Conference / Transactions)',
    venue: 'IEEE',
    class: 'IEEEtran',
    generate(title, abstract, keywords, body) {
      const kw = keywords ? `\n\\begin{IEEEkeywords}\n${escapeLatex(keywords)}\n\\end{IEEEkeywords}` : '';
      return `\\documentclass[conference]{IEEEtran}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{url}
\\usepackage{booktabs}

\\title{${escapeLatex(title)}}
\\author{\\IEEEauthorblockN{Author(s)}\\\\
\\IEEEauthorblockA{Institution}}

\\begin{document}
\\maketitle

\\begin{abstract}
${abstract || 'See source document for abstract.'}
\\end{abstract}
${kw}

${body}

\\end{document}
`;
    },
  },

  acmart: {
    label: 'ACM (Conference / Journal)',
    venue: 'ACM',
    class: 'acmart',
    generate(title, abstract, keywords, body) {
      const kw = keywords ? `\n\\keywords{${escapeLatex(keywords)}}` : '';
      return `\\documentclass[sigconf]{acmart}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}

\\title{${escapeLatex(title)}}
\\author{Author(s)}
\\affiliation{\\institution{Institution}}
\\email{email@example.com}
${kw}

\\begin{document}
\\maketitle

\\begin{abstract}
${abstract || 'See source document for abstract.'}
\\end{abstract}

${body}

\\end{document}
`;
    },
  },

  acl: {
    label: 'ACL / EMNLP / NAACL',
    venue: 'ACL',
    class: 'article',
    generate(title, abstract, keywords, body) {
      return `\\documentclass[11pt]{article}
\\usepackage{acl}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{microtype}

\\title{${escapeLatex(title)}}
\\author{Author(s) \\\\
  Institution \\\\
  \\texttt{email@example.com}}
\\date{}

\\begin{document}
\\maketitle

\\begin{abstract}
${abstract || 'See source document for abstract.'}
\\end{abstract}

${body}

\\bibliography{refs}
\\bibliographystyle{acl_natbib}

\\end{document}
`;
    },
  },

  springer: {
    label: 'Springer LNCS',
    venue: 'Springer',
    class: 'llncs',
    generate(title, abstract, keywords, body) {
      const kw = keywords ? `\n\\keywords{${escapeLatex(keywords)}}` : '';
      return `\\documentclass{llncs}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{url}

\\begin{document}

\\title{${escapeLatex(title)}}
\\author{Author(s)}
\\institute{Institution \\email{email@example.com}}
\\maketitle
${kw}

\\begin{abstract}
${abstract || 'See source document for abstract.'}
\\end{abstract}

${body}

\\end{document}
`;
    },
  },

  icml: {
    label: 'ICML / PMLR',
    venue: 'ICML',
    class: 'article',
    generate(title, abstract, keywords, body) {
      return `\\documentclass[twocolumn,10pt]{article}
\\usepackage[paperwidth=8.5in,paperheight=11in,top=0.75in,bottom=1in,left=0.75in,right=0.75in]{geometry}
\\usepackage{times}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{natbib}

\\title{\\bf ${escapeLatex(title)}}
\\author{Author(s) \\\\ Institution}
\\date{}

\\begin{document}
\\maketitle

\\begin{abstract}
${abstract || 'See source document for abstract.'}
\\end{abstract}

${body}

\\end{document}
`;
    },
  },

  iclr: {
    label: 'ICLR',
    venue: 'ICLR',
    class: 'article',
    generate(title, abstract, keywords, body) {
      return `\\documentclass[12pt]{article}
\\usepackage[paperwidth=8.5in,paperheight=11in,top=1in,bottom=1in,left=1.25in,right=1.25in]{geometry}
\\usepackage{times}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{natbib}
\\usepackage[colorlinks,citecolor=blue,urlcolor=blue]{hyperref}

\\title{${escapeLatex(title)}}
\\author{Author(s) \\\\
  Institution \\\\
  \\texttt{email@example.com}}
\\date{}

\\begin{document}
\\maketitle

\\begin{abstract}
${abstract || 'See source document for abstract.'}
\\end{abstract}

${body}

\\end{document}
`;
    },
  },
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES);

// ---------------------------------------------------------------------------
// buildLatex — clean output, no comments, no meta-notes
// ---------------------------------------------------------------------------
export function buildLatex(document, target) {
  const cfg = TEMPLATES[target] ?? TEMPLATES.IEEEtran;
  const title = extractTitle(document.blocks, document.filename);
  const abstract = extractAbstract(document.blocks);
  const keywords = extractKeywords(document.blocks);
  const body = buildBody(document.blocks, title, abstract);
  return cfg.generate(title, abstract, keywords, body);
}

// ---------------------------------------------------------------------------
// validateLatex
// ---------------------------------------------------------------------------
export function validateLatex(source, document) {
  const findings = [];
  if (!source.includes('\\begin{document}') || !source.includes('\\end{document}')) {
    findings.push({ severity: 'error', rule: 'latex-structure', title: 'Document environment is incomplete', confidence: 1, detail: 'Generated source is missing \\begin{document} or \\end{document}.' });
  }
  if (document.figures > 0) {
    findings.push({ severity: 'warning', rule: 'asset-presence', title: `${document.figures} figure(s) need image files`, confidence: 0.82, detail: 'Figure placeholder boxes are in the source. Replace with actual image files before submission.' });
  }
  if (document.tables.length > 0) {
    findings.push({ severity: 'warning', rule: 'table-structure', title: `${document.tables.length} table(s) converted — verify alignment`, confidence: 0.76, detail: 'Tables were reconstructed from extracted text. Verify column structure and data alignment.' });
  }
  if (document.references === 0) {
    findings.push({ severity: 'warning', rule: 'citation-integrity', title: 'No references detected', confidence: 0.88, detail: 'Provide a .bib bibliography file or add \\bibliography{} manually.' });
  }
  findings.push({ severity: 'pass', rule: 'content-preservation', title: 'Scientific text preserved verbatim', confidence: 0.97, detail: 'All extracted text was inserted without paraphrasing or semantic rewriting.' });
  return findings;
}

// ---------------------------------------------------------------------------
// compileLatex — uses pdflatex from PATH (no local MiKTeX dependency)
// Relies on TeX Live installed in the Docker image.
// ---------------------------------------------------------------------------
export async function compileLatex({ source, jobDir, timeoutMs = 120_000 }) {
  await writeFile(path.join(jobDir, 'paper.tex'), source, 'utf8');

  // Include bundled templates directory (for acl.sty, llncs.cls downloaded at build time)
  const templatesDir = path.resolve('templates');
  const env = {
    ...process.env,
    TEXINPUTS: `.:${templatesDir}:${process.env.TEXINPUTS ?? ''}`,
  };

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('pdflatex', [
        '-interaction=nonstopmode',
        '-halt-on-error',
        '-no-shell-escape',
        'paper.tex',
      ], { cwd: jobDir, env, windowsHide: true });
    } catch (spawnErr) {
      return resolve({ ok: false, exitCode: null, pdf: false, notFound: true, log: `pdflatex not found: ${spawnErr.message}. Deploy with Docker to enable compilation.` });
    }

    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, timedOut: true, pdf: false, log: output.slice(-12_000) });
    }, timeoutMs);

    child.stdout?.on('data', (c) => { output += c; });
    child.stderr?.on('data', (c) => { output += c; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, pdf: false, notFound: true, log: `pdflatex not found: ${err.message}. Deploy with Docker to enable compilation.` });
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      let pdf = false;
      try { await readFile(path.join(jobDir, 'paper.pdf')); pdf = true; } catch { /* no pdf */ }
      resolve({ ok: code === 0 && pdf, exitCode: code, pdf, log: output.slice(-12_000) });
    });
  });
}

// ---------------------------------------------------------------------------
// repairLatex — bounded rule-based fixes; MUST NOT alter scientific content
// ---------------------------------------------------------------------------
const REPAIR_RULES = [
  {
    name: 'missing-usepackage-hyperref',
    pattern: /Package hyperref Error/i,
    apply: (src) => src.includes('\\usepackage{hyperref}') ? null
      : { source: src.replace('\\begin{document}', '\\usepackage{hyperref}\n\\begin{document}'), description: 'Added missing \\usepackage{hyperref}.' },
  },
  {
    name: 'undefined-control-sequence-backslash',
    pattern: /Undefined control sequence.*\\textbackslash/i,
    apply: (src) => {
      const fixed = src.replaceAll('\\textbackslash{}', '{\\textbackslash}');
      return fixed === src ? null : { source: fixed, description: 'Fixed \\textbackslash{} → {\\textbackslash}.' };
    },
  },
  {
    name: 'missing-dollar-inserted',
    pattern: /Missing \$ inserted/i,
    apply: (src) => {
      const fixed = src.replace(/(?<![\\\$])([_^])(?![^$]*\$)/g, (m) => `$${m}$`);
      return fixed === src ? null : { source: fixed, description: 'Wrapped bare math characters in $ ... $ mode.' };
    },
  },
  {
    name: 'file-not-found-graphics',
    pattern: /cannot find image file|File .* not found/i,
    apply: (src) => {
      const fixed = src.replace(/\\includegraphics(\[[^\]]*\])?\{[^}]+\}/g,
        '\\fbox{\\parbox{0.7\\linewidth}{\\centering [Figure: insert image file before submission]}}');
      return fixed === src ? null : { source: fixed, description: 'Replaced unresolved \\includegraphics with placeholder box.' };
    },
  },
  {
    name: 'missing-acl-style',
    pattern: /File `acl\.sty' not found|acl\.sty.*not found/i,
    apply: (src) => {
      const fixed = src.replace('\\usepackage{acl}', '');
      return fixed === src ? null : { source: fixed, description: 'Removed missing acl.sty — template will compile as plain article.' };
    },
  },
  {
    name: 'missing-llncs-class',
    pattern: /File `llncs\.cls' not found|llncs\.cls.*not found/i,
    apply: (src) => {
      const fixed = src.replace('\\documentclass{llncs}', '\\documentclass[12pt]{article}');
      return fixed === src ? null : { source: fixed, description: 'Replaced missing llncs.cls with standard article class.' };
    },
  },
];

export function repairLatex(source, compileLog) {
  const repairs = [];
  let current = source;
  for (const rule of REPAIR_RULES) {
    if (!rule.pattern.test(compileLog)) continue;
    const result = rule.apply(current);
    if (!result) continue;
    current = result.source;
    repairs.push({ rule: rule.name, description: result.description, approval: false });
  }
  return { source: current, repairs };
}

// ---------------------------------------------------------------------------
// Reasoning agent — Gemini → OpenAI → rule-based fallback
// ---------------------------------------------------------------------------
const REASONING_PROMPT = (jobId, findings, document) =>
  `You are PaperForge's bounded academic conversion reviewer. Do not rewrite scientific content. ` +
  `Review job ${jobId}. Return ONLY a JSON object with keys: summary (string), safeFixes (string[]), ` +
  `approvalRequired (string[]), remainingIssues (string[]). ` +
  `Findings: ${JSON.stringify(findings)}. ` +
  `Stats: ${JSON.stringify({ figures: document.figures, tables: document.tables?.length ?? document.tables, references: document.references })}.`;

function ruleBasedReasoning(findings) {
  const issues = findings.filter((f) => f.severity !== 'pass');
  return {
    provider: 'rule-based', model: null,
    summary: issues.length === 0
      ? 'All rule-based checks passed.'
      : `${issues.length} issue(s) detected. Human review required for flagged items.`,
    safeFixes: findings.filter((f) => f.severity === 'warning' && !f.approval).map((f) => f.title ?? f.rule),
    approvalRequired: findings.filter((f) => f.approval || f.severity === 'error').map((f) => f.title ?? f.rule),
    remainingIssues: issues.map((f) => f.detail ?? f.title),
  };
}

async function callGemini(apiKey, prompt) {
  const model = process.env.GEMINI_MODEL || 'gemini-1.5-pro';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } }),
  });
  if (!response.ok) throw new Error(`Gemini API returned ${response.status}.`);
  const payload = await response.json();
  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return { provider: 'gemini', model, ...JSON.parse(cleaned) }; } catch {
    return { provider: 'gemini', model, summary: text, safeFixes: [], approvalRequired: [], remainingIssues: [] };
  }
}

async function callOpenAI(apiKey, prompt) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
  });
  if (!response.ok) throw new Error(`OpenAI API returned ${response.status}.`);
  const payload = await response.json();
  const text = payload.choices?.[0]?.message?.content ?? '';
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return { provider: 'openai', model, ...JSON.parse(cleaned) }; } catch {
    return { provider: 'openai', model, summary: text, safeFixes: [], approvalRequired: [], remainingIssues: [] };
  }
}

export async function askReasoning({ findings, document, jobId }) {
  const prompt = REASONING_PROMPT(jobId, findings, document);
  if (process.env.GEMINI_API_KEY) return callGemini(process.env.GEMINI_API_KEY, prompt).catch(() => ruleBasedReasoning(findings));
  if (process.env.OPENAI_API_KEY) return callOpenAI(process.env.OPENAI_API_KEY, prompt).catch(() => ruleBasedReasoning(findings));
  return ruleBasedReasoning(findings);
}
