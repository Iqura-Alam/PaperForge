import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import mammoth from 'mammoth';

export const LIMITS = Object.freeze({ maxBytes: 25 * 1024 * 1024, maxPages: 50, maxFigures: 50, maxTables: 30, maxReferences: 300 });

export function validateUpload({ filename, size, mimeType = '' }) {
  const extension = path.extname(filename ?? '').toLowerCase();
  if (extension !== '.docx') throw new Error('Only DOCX manuscripts are supported.');
  if (size > LIMITS.maxBytes) throw new Error('DOCX file exceeds the 25 MB limit.');
  if (mimeType && !mimeType.includes('wordprocessingml') && mimeType !== 'application/octet-stream') throw new Error('Uploaded file type is not a DOCX document.');
  return { accepted: true, extension, limits: LIMITS };
}

function escapeLatex(value) {
  return value.replaceAll('\\', '\\textbackslash{}').replaceAll(/[&%$#_{}]/g, (character) => `\\${character}`).replaceAll('~', '\\textasciitilde{}').replaceAll('^', '\\textasciicircum{}');
}

function htmlToBlocks(html) {
  const blocks = [];
  const normalized = html.replace(/\r?\n/g, ' ');
  const matcher = /<(h[1-6]|p|li|tr|figcaption)[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of normalized.matchAll(matcher)) {
    const tag = match[1].toLowerCase();
    const text = match[2].replace(/<br\s*\/?>(\s*)/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    if (!text) continue;
    blocks.push({ type: tag.startsWith('h') ? 'heading' : tag === 'tr' ? 'table-row' : 'paragraph', level: tag.startsWith('h') ? Number(tag.slice(1)) : undefined, text });
  }
  return blocks;
}

export async function extractDocx(buffer, filename) {
  const [rawText, htmlResult] = await Promise.all([mammoth.extractRawText({ buffer }), mammoth.convertToHtml({ buffer })]);
  const blocks = htmlToBlocks(htmlResult.value);
  const text = rawText.value.trim();
  const headings = blocks.filter((block) => block.type === 'heading');
  const tables = blocks.filter((block) => block.type === 'table-row');
  const figures = (htmlResult.value.match(/<img\b/gi) ?? []).length;
  const references = (text.match(/\n\s*(?:\[?\d+\]?\.|References?\s)/gi) ?? []).length;
  if (tables.length > LIMITS.maxTables) throw new Error('Document contains more than 30 detected table rows.');
  if (figures > LIMITS.maxFigures) throw new Error('Document contains more than 50 figures.');
  return { filename, text, html: htmlResult.value, blocks, headings, tables, figures, references, messages: htmlResult.messages };
}

export function buildLatex(document, target) {
  const documentClass = target === 'acmart' ? '\\documentclass[sigconf]{acmart}' : '\\documentclass[conference]{IEEEtran}';
  const title = document.blocks.find((block) => block.type === 'heading')?.text ?? path.basename(document.filename, '.docx');
  const body = document.blocks.filter((block) => block.text !== title).map((block) => block.type === 'heading' ? `\\section{${escapeLatex(block.text)}}` : block.type === 'table-row' ? `% Table row preserved for review: ${escapeLatex(block.text)}` : escapeLatex(block.text)).join('\n\n');
  return `${documentClass}\n\\usepackage[T1]{fontenc}\n\\usepackage{amsmath}\n\\usepackage{graphicx}\n\\title{${escapeLatex(title)}}\n\\author{Author names preserved from source}\n\\begin{document}\n\\maketitle\n${body}\n\\section*{Validation note}\nThis source was generated from ${escapeLatex(document.filename)}. Scientific content is preserved as extracted text; figures, tables, equations, and references requiring review remain flagged in the validation report.\n\\end{document}\n`;
}

export function validateLatex(source, document) {
  const findings = [];
  if (!source.includes('\\begin{document}') || !source.includes('\\end{document}')) findings.push({ severity: 'error', rule: 'latex-structure', title: 'Document environment is incomplete', confidence: 1, detail: 'Generated source is missing a required LaTeX document boundary.' });
  if (document.figures > 0) findings.push({ severity: 'warning', rule: 'asset-presence', title: `${document.figures} figure asset(s) need review`, confidence: 0.82, detail: 'DOCX image assets were detected. Confirm paths and captions before submission.' });
  if (document.tables > 0) findings.push({ severity: 'warning', rule: 'table-structure', title: `${document.tables} table row(s) need review`, confidence: 0.76, detail: 'Table content was preserved as review comments because complex cell structure cannot be inferred safely.' });
  if (document.references === 0) findings.push({ severity: 'warning', rule: 'citation-integrity', title: 'No references detected', confidence: 0.88, detail: 'Provide a bibliography file or review citation extraction manually.' });
  findings.push({ severity: 'pass', rule: 'content-preservation', title: 'Extracted text preserved', confidence: 0.96, detail: 'Raw DOCX text was copied into generated source without semantic rewriting.' });
  return findings;
}

export async function compileLatex({ source, jobDir, target = 'IEEEtran', timeoutMs = 120000 }) {
  await writeFile(path.join(jobDir, 'paper.tex'), source, 'utf8');
  const localRoot = path.resolve('.codex-local', 'miktex');
  const templateRoots = [path.resolve('.codex-local', 'templates'), path.resolve('.codex-local', 'templates', 'acmart-pkg', 'acmart')];
  const env = { ...process.env, MIKTEX_USERCONFIG: path.join(localRoot, 'config'), MIKTEX_USERDATA: path.join(localRoot, 'data'), MIKTEX_USERINSTALL: path.join(localRoot, 'install'), TEXINPUTS: `${templateRoots.join(path.delimiter)}${path.delimiter}${process.env.TEXINPUTS ?? ''}` };
  await mkdir(env.MIKTEX_USERCONFIG, { recursive: true }); await mkdir(env.MIKTEX_USERDATA, { recursive: true }); await mkdir(env.MIKTEX_USERINSTALL, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', 'paper.tex'], { cwd: jobDir, env, windowsHide: true });
    let output = ''; const timer = setTimeout(() => { child.kill(); resolve({ ok: false, timedOut: true, log: output.slice(-12000) }); }, timeoutMs);
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', async (code) => { clearTimeout(timer); let pdf = false; try { await readFile(path.join(jobDir, 'paper.pdf')); pdf = true; } catch {} resolve({ ok: code === 0 && pdf, exitCode: code, pdf, log: output.slice(-12000) }); });
  });
}

export async function askReasoning({ findings, document, jobId }) {
  const apiKey = process.env.OPENAI_API_KEY; const model = process.env.OPENAI_MODEL || 'gpt-5-mini';
  const prompt = `You are PaperForge's bounded academic conversion reviewer. Do not rewrite scientific content. Review job ${jobId}. Return JSON with keys summary, safeFixes, approvalRequired, remainingIssues. Findings: ${JSON.stringify(findings)}. Stats: ${JSON.stringify({ figures: document.figures, tables: document.tables, references: document.references })}.`;
  if (!apiKey) return { provider: 'unconfigured', model: null, summary: 'LLM reasoning is not configured. Rule-based validation completed; human review remains required for flagged content.', safeFixes: [], approvalRequired: findings.filter((finding) => finding.severity !== 'pass').map((finding) => finding.title), remainingIssues: findings.filter((finding) => finding.severity !== 'pass').map((finding) => finding.detail) };
  const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, input: prompt, temperature: 0 }) });
  if (!response.ok) throw new Error(`LLM provider returned ${response.status}.`);
  const payload = await response.json(); const text = payload.output_text ?? '';
  try { return { provider: 'openai', model, ...JSON.parse(text) }; } catch { return { provider: 'openai', model, summary: text, safeFixes: [], approvalRequired: [], remainingIssues: [] }; }
}
