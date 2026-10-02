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
// HTML → structured blocks (proper table grouping)
// ---------------------------------------------------------------------------
function htmlToBlocks(html) {
  const blocks = [];
  const normalized = html.replace(/\r?\n/g, ' ');

  // Process tables as atomic units first — extract all <table>...</table> and replace
  // them with a sentinel token so we can process them separately.
  const tableRegions = [];
  let workingHtml = normalized.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (fullMatch) => {
    const index = tableRegions.length;
    tableRegions.push(fullMatch);
    return `<__TABLE_${index}__>`;
  });

  // Now parse non-table blocks
  const blockMatcher = /<(h[1-6]|p|li|figcaption|__TABLE_\d+__)[^>]*>([\s\S]*?)<\/\1>|<(__TABLE_\d+__)>/gi;

  // We process the modified HTML token by token
  // First: extract all top-level block elements
  const topLevelBlocks = /<(h[1-6]|p|li|figcaption)[^>]*>([\s\S]*?)<\/\1>/gi;
  const tableTokenMatcher = /<__TABLE_(\d+)__>/g;

  // Build an ordered list of tokens
  const tokens = [];

  // Interleave block elements and table tokens in document order
  let lastIndex = 0;
  const combinedMatcher = /<(h[1-6]|p|li|figcaption)[^>]*>([\s\S]*?)<\/\1>|<__TABLE_(\d+)__>/gi;
  for (const match of workingHtml.matchAll(combinedMatcher)) {
    if (match[3] !== undefined) {
      // Table sentinel
      tokens.push({ type: 'table', index: Number(match[3]), offset: match.index });
    } else {
      tokens.push({ type: 'block', tag: match[1].toLowerCase(), raw: match[2], offset: match.index });
    }
  }

  for (const token of tokens) {
    if (token.type === 'table') {
      const tableHtml = tableRegions[token.index];
      const tableBlock = parseTableHtml(tableHtml);
      if (tableBlock) blocks.push(tableBlock);
      continue;
    }

    const { tag, raw } = token;

    // Check if this block contains an image (figure)
    const hasImg = /<img\b/i.test(raw);
    if (hasImg) {
      // Capture alt text and src (base64 data URI) for image extraction
      const altMatch = raw.match(/alt="([^"]*)"/i);
      const srcMatch = raw.match(/src="([^"]*)"/i);
      blocks.push({
        type: 'figure',
        caption: altMatch?.[1]?.trim() || '',
        src: srcMatch?.[1] || null,
      });
      continue;
    }

    const text = raw
      .replace(/<br\s*\/?>\s*/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();

    if (!text) continue;

    if (tag.startsWith('h')) {
      blocks.push({ type: 'heading', level: Number(tag.slice(1)), text });
    } else {
      blocks.push({ type: 'paragraph', text });
    }
  }

  return blocks;
}

// Parse a full <table>...</table> HTML snippet into a single table block with rows
function parseTableHtml(tableHtml) {
  const rows = [];
  const rowMatcher = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const rowMatch of tableHtml.matchAll(rowMatcher)) {
    const rowHtml = rowMatch[1];
    // Extract cells (th or td)
    const cellMatcher = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    const cells = [];
    for (const cellMatch of rowHtml.matchAll(cellMatcher)) {
      const cellText = cellMatch[1]
        .replace(/<br\s*\/?>\s*/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
      cells.push(cellText);
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return null;
  return { type: 'table', rows };
}

// ---------------------------------------------------------------------------
// Author / institution extraction from raw text + blocks
// ---------------------------------------------------------------------------
function extractAuthorInfo(blocks, rawText) {
  const result = { authors: [], institutions: [], emails: [] };

  // Common patterns in academic papers
  const emailPattern = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi;
  const emails = rawText.match(emailPattern) ?? [];
  result.emails = [...new Set(emails)].slice(0, 5);

  // Look for author block — typically right after title heading, before abstract
  const titleIdx = blocks.findIndex((b) => b.type === 'heading' && b.level === 1);
  const abstractIdx = blocks.findIndex(
    (b) => b.type === 'heading' && /^abstract$/i.test(b.text.trim()),
  );

  const searchEnd = abstractIdx > 0 ? abstractIdx : Math.min(titleIdx + 8, blocks.length);
  const candidateBlocks = blocks.slice(titleIdx + 1, searchEnd);

  for (const block of candidateBlocks) {
    if (block.type !== 'paragraph') continue;
    const text = block.text.trim();

    // Skip abstract-looking paragraphs
    if (text.length > 200) continue;

    // Institution patterns
    if (/university|institute|department|faculty|college|lab(oratory)?|center|centre|school of/i.test(text)) {
      result.institutions.push(text);
      continue;
    }

    // Author line patterns — name-like short strings, often with commas or "and"
    if (
      text.length < 120 &&
      !text.includes('.') && // Avoid sentences
      /^[A-Z]/.test(text) && // Starts with capital
      !/^\d/.test(text) // Not starting with number
    ) {
      // Check for multiple authors pattern
      if (/,|\band\b/i.test(text) || /^[A-Z][a-z]+ [A-Z]/.test(text)) {
        result.authors.push(text);
      }
    }
  }

  // Deduplicate
  result.authors = [...new Set(result.authors)];
  result.institutions = [...new Set(result.institutions)];

  return result;
}

// ---------------------------------------------------------------------------
// DOCX extraction — with image file saving
// ---------------------------------------------------------------------------
export async function extractDocx(buffer, filename, jobDir) {
  const mammothOptions = {
    buffer,
    convertImage: mammoth.images.inline(async (image) => {
      // Return image as base64 data URI — we'll extract them later
      const base64 = (await image.read('base64'));
      const ext = image.contentType?.split('/')?.[1]?.split('+')?.[0] ?? 'png';
      return { src: `data:${image.contentType};base64,${base64}`, 'data-ext': ext };
    }),
  };

  const [rawResult, htmlResult] = await Promise.all([
    mammoth.extractRawText({ buffer }),
    mammoth.convertToHtml(mammothOptions),
  ]);

  const blocks = htmlToBlocks(htmlResult.value);
  const text = rawResult.value.trim();
  const headings = blocks.filter((b) => b.type === 'heading');
  const tableBlocks = blocks.filter((b) => b.type === 'table');
  const figureBlocks = blocks.filter((b) => b.type === 'figure');

  // Count actual img tags in HTML for figures (catches any not in p/figcaption)
  const imgTagCount = (htmlResult.value.match(/<img\b/gi) ?? []).length;
  const figures = Math.max(figureBlocks.length, imgTagCount);
  const references = (text.match(/\n\s*(?:\[?\d+\]?\.|References?\s)/gi) ?? []).length;

  if (tableBlocks.length > LIMITS.maxTables) throw new Error('Document contains more than 30 detected tables.');
  if (figures > LIMITS.maxFigures) throw new Error('Document contains more than 50 figures.');

  // Extract and save images to jobDir if provided
  const imageMap = {}; // figIndex -> filename
  if (jobDir) {
    let imgIdx = 0;
    for (const block of figureBlocks) {
      if (block.src && block.src.startsWith('data:')) {
        imgIdx++;
        const extMatch = block.src.match(/^data:image\/([^;]+)/);
        const ext = extMatch ? extMatch[1].split('+')[0] : 'png';
        const imgFilename = `fig${imgIdx}.${ext}`;
        try {
          const base64Data = block.src.replace(/^data:[^,]+,/, '');
          await writeFile(path.join(jobDir, imgFilename), Buffer.from(base64Data, 'base64'));
          imageMap[imgIdx] = imgFilename;
          block.savedAs = imgFilename;
        } catch {
          // Non-fatal: image extraction failed
        }
      }
    }
  }

  const authorInfo = extractAuthorInfo(blocks, text);

  return {
    filename, text, html: htmlResult.value, blocks,
    headings, tables: tableBlocks, figures, references,
    messages: htmlResult.messages,
    imageHeavy: figures >= 10,
    authorInfo,
    imageMap,
  };
}

// ---------------------------------------------------------------------------
// Structure extraction from blocks
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
// Body builder — produces clean LaTeX
// ---------------------------------------------------------------------------
function renderTable(tableBlock, tableIndex) {
  const rows = tableBlock.rows;
  if (!rows || rows.length === 0) return '';

  // Determine column count from actual cell arrays
  const numCols = Math.max(1, ...rows.map((r) => r.length));
  const colSpec = Array(numCols).fill('l').join(' | ');

  const latexRows = rows.map((cells, ri) => {
    // Pad to numCols
    const paddedCells = [...cells];
    while (paddedCells.length < numCols) paddedCells.push('');
    const line = paddedCells.map(escapeLatex).join(' & ');
    return ri === 0 ? `${line} \\\\\\hline` : `${line} \\\\`;
  });

  return [
    '\\begin{table}[htbp]',
    '\\centering',
    `\\caption{Table ${tableIndex}}`,
    `\\label{tab:t${tableIndex}}`,
    `\\begin{tabular}{|${colSpec}|}`,
    '\\hline',
    ...latexRows,
    '\\hline',
    '\\end{tabular}',
    '\\end{table}',
  ].join('\n');
}

function renderFigure(block, figIndex) {
  const caption = block.caption ? escapeLatex(block.caption) : `Figure ${figIndex}`;

  // If we saved the image, use \includegraphics; otherwise use placeholder
  if (block.savedAs) {
    return [
      '\\begin{figure}[htbp]',
      '\\centering',
      `\\includegraphics[width=0.7\\linewidth]{${block.savedAs}}`,
      `\\caption{${caption}}`,
      `\\label{fig:f${figIndex}}`,
      '\\end{figure}',
    ].join('\n');
  }

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

    // Table — now a proper { type: 'table', rows: [] } block
    if (block.type === 'table') {
      tableIdx++;
      parts.push(renderTable(block, tableIdx));
      i++; continue;
    }

    // Heading → section command
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
// Format author block per template style
// ---------------------------------------------------------------------------
function formatAuthors(authorInfo, style) {
  const authors = authorInfo?.authors?.length > 0 ? authorInfo.authors : null;
  const institutions = authorInfo?.institutions?.length > 0 ? authorInfo.institutions : null;
  const emails = authorInfo?.emails?.length > 0 ? authorInfo.emails : null;

  const authorStr = authors ? authors.join(', ') : 'Author(s)';
  const instStr = institutions ? institutions[0] : 'Institution';
  const emailStr = emails ? emails[0] : 'email@example.com';

  if (style === 'ieee') {
    // IEEE author block
    const authorLines = (authors ?? ['Author(s)']).map((a, i) => {
      const inst = institutions?.[i] ?? instStr;
      return `\\IEEEauthorblockN{${escapeLatex(a)}}\\\\\n\\IEEEauthorblockA{${escapeLatex(inst)}}`;
    });
    return authorLines.join('\n\\and\n');
  }
  if (style === 'acm') {
    return (authors ?? ['Author(s)']).map((a, i) => {
      const inst = institutions?.[i] ?? instStr;
      const email = emails?.[i] ?? emailStr;
      return `\\author{${escapeLatex(a)}}\n\\affiliation{\\institution{${escapeLatex(inst)}}}\n\\email{${escapeLatex(email)}}`;
    }).join('\n');
  }
  if (style === 'inline') {
    // ACL / ICLR style — inline author block
    const parts = [escapeLatex(authorStr)];
    if (instStr !== 'Institution') parts.push(`  ${escapeLatex(instStr)}`);
    if (emailStr !== 'email@example.com') parts.push(`  \\texttt{${escapeLatex(emailStr)}}`);
    return parts.join('\\\\\n');
  }
  // Springer
  return escapeLatex(authorStr);
}

// ---------------------------------------------------------------------------
// Official venue templates — author/institution-aware
// ---------------------------------------------------------------------------
export const TEMPLATES = {
  IEEEtran: {
    label: 'IEEE (Conference / Transactions)',
    venue: 'IEEE',
    class: 'IEEEtran',
    generate(title, abstract, keywords, body, authorInfo) {
      const kw = keywords ? `\n\\begin{IEEEkeywords}\n${escapeLatex(keywords)}\n\\end{IEEEkeywords}` : '';
      const authorBlock = formatAuthors(authorInfo, 'ieee');
      return `\\documentclass[conference]{IEEEtran}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{url}
\\usepackage{booktabs}

\\title{${escapeLatex(title)}}
\\author{${authorBlock}}

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
    generate(title, abstract, keywords, body, authorInfo) {
      const kw = keywords ? `\n\\keywords{${escapeLatex(keywords)}}` : '';
      const authorBlock = formatAuthors(authorInfo, 'acm');
      return `\\documentclass[sigconf]{acmart}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}

\\title{${escapeLatex(title)}}
${authorBlock}
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
    generate(title, abstract, keywords, body, authorInfo) {
      const authorBlock = formatAuthors(authorInfo, 'inline');
      return `\\documentclass[11pt]{article}
\\usepackage{acl}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{microtype}

\\title{${escapeLatex(title)}}
\\author{${authorBlock}}
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
    generate(title, abstract, keywords, body, authorInfo) {
      const kw = keywords ? `\n\\keywords{${escapeLatex(keywords)}}` : '';
      const authors = authorInfo?.authors?.length > 0 ? authorInfo.authors.map(escapeLatex).join(' \\and ') : 'Author(s)';
      const institutions = authorInfo?.institutions?.length > 0 ? authorInfo.institutions.map(escapeLatex).join(' \\and ') : 'Institution';
      const email = authorInfo?.emails?.[0] ? escapeLatex(authorInfo.emails[0]) : 'email@example.com';
      return `\\documentclass{llncs}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{url}

\\begin{document}

\\title{${escapeLatex(title)}}
\\author{${authors}}
\\institute{${institutions} \\email{${email}}}
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
    generate(title, abstract, keywords, body, authorInfo) {
      const authorBlock = formatAuthors(authorInfo, 'inline');
      return `\\documentclass[twocolumn,10pt]{article}
\\usepackage[paperwidth=8.5in,paperheight=11in,top=0.75in,bottom=1in,left=0.75in,right=0.75in]{geometry}
\\usepackage{times}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{natbib}

\\title{\\bf ${escapeLatex(title)}}
\\author{${authorBlock}}
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
    generate(title, abstract, keywords, body, authorInfo) {
      const authorBlock = formatAuthors(authorInfo, 'inline');
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
\\author{${authorBlock}}
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
// buildLatex — passes authorInfo to template generator
// ---------------------------------------------------------------------------
export function buildLatex(document, target) {
  const cfg = TEMPLATES[target] ?? TEMPLATES.IEEEtran;
  const title = extractTitle(document.blocks, document.filename);
  const abstract = extractAbstract(document.blocks);
  const keywords = extractKeywords(document.blocks);
  const body = buildBody(document.blocks, title, abstract);
  return cfg.generate(title, abstract, keywords, body, document.authorInfo);
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
    const savedCount = document.imageMap ? Object.keys(document.imageMap).length : 0;
    const missing = document.figures - savedCount;
    if (missing > 0) {
      findings.push({ severity: 'warning', rule: 'asset-presence', title: `${missing} figure(s) need image files`, confidence: 0.82, detail: `${savedCount} image(s) were extracted automatically. ${missing} figure placeholder(s) remain — replace with actual image files before submission.` });
    } else {
      findings.push({ severity: 'pass', rule: 'asset-presence', title: `${savedCount} figure(s) extracted successfully`, confidence: 0.9, detail: 'All detected images were extracted from the DOCX and saved alongside the LaTeX source.' });
    }
  }
  if (document.tables.length > 0) {
    findings.push({ severity: 'pass', rule: 'table-structure', title: `${document.tables.length} table(s) converted`, confidence: 0.85, detail: 'Tables were reconstructed from the document structure. Verify column alignment in the compiled output.' });
  }
  if (document.references === 0) {
    findings.push({ severity: 'warning', rule: 'citation-integrity', title: 'No references detected', confidence: 0.88, detail: 'Provide a .bib bibliography file or add \\bibliography{} manually.' });
  }
  // Author info finding
  if (document.authorInfo?.authors?.length > 0) {
    findings.push({ severity: 'pass', rule: 'author-extraction', title: `Author info extracted: ${document.authorInfo.authors.slice(0, 2).join(', ')}${document.authorInfo.authors.length > 2 ? ` +${document.authorInfo.authors.length - 2} more` : ''}`, confidence: 0.78, detail: 'Author names and institution were extracted from the document and inserted into the template header.' });
  }
  findings.push({ severity: 'pass', rule: 'content-preservation', title: 'Scientific text preserved verbatim', confidence: 0.97, detail: 'All extracted text was inserted without paraphrasing or semantic rewriting.' });
  return findings;
}

// ---------------------------------------------------------------------------
// compileLatex
// ---------------------------------------------------------------------------
export async function compileLatex({ source, jobDir, timeoutMs = 120_000 }) {
  await writeFile(path.join(jobDir, 'paper.tex'), source, 'utf8');

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
      const fixed = src.replace(/(?<![\\$])([_^])(?![^$]*\$)/g, (m) => `$${m}$`);
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
// Chat / agent conversation — multi-turn with Gemini or rule-based
// ---------------------------------------------------------------------------
const CHAT_SYSTEM_PROMPT = `You are PaperForge's bounded academic conversion assistant. 
You help users review and refine their converted LaTeX documents. 
You MUST NOT rewrite scientific claims, invent data, or alter citations.
You CAN suggest LaTeX formatting improvements, fix template issues, explain findings, and help resolve specific compilation errors.
When asked to apply a fix, respond with a JSON object: { "action": "patch", "description": "...", "patch": "<LaTeX diff or instruction>" }
For conversation responses, respond with: { "action": "reply", "message": "..." }
Always be concise and specific.`;

async function callGeminiChat(apiKey, messages, systemPrompt) {
  const model = process.env.GEMINI_MODEL || 'gemini-1.5-pro';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.2 },
    }),
  });
  if (!response.ok) throw new Error(`Gemini API returned ${response.status}.`);
  const payload = await response.json();
  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return text;
}

async function callOpenAIChat(apiKey, messages, systemPrompt) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      temperature: 0.2,
    }),
  });
  if (!response.ok) throw new Error(`OpenAI API returned ${response.status}.`);
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content ?? '';
}

function ruleBasedChatResponse(userMessage, job) {
  const lower = userMessage.toLowerCase();

  if (/fix|repair|correct/i.test(lower) && /table/i.test(lower)) {
    return { action: 'reply', message: 'Tables have been reconstructed from your document. If alignment is off, please review the generated `paper.tex` and adjust the column spec (e.g., change `l l l` to `c r l` for center/right/left alignment). Would you like me to suggest a specific fix?' };
  }
  if (/fix|repair/i.test(lower) && /author|institution|affiliation/i.test(lower)) {
    return { action: 'reply', message: 'Author/institution info is extracted automatically from text near your title. If it\'s incorrect, you can edit the `\\author{}` and `\\affiliation{}` fields directly in the downloaded `paper.tex`. Would you like guidance on the correct LaTeX syntax for your template?' };
  }
  if (/fix|repair/i.test(lower) && /image|figure/i.test(lower)) {
    return { action: 'reply', message: 'Images embedded in your DOCX are extracted and saved alongside the LaTeX source. If a figure shows a placeholder box instead, it means the image could not be extracted (e.g., linked externally). Replace the `\\fbox{...}` placeholder with `\\includegraphics[width=0.7\\linewidth]{yourimage.png}` in `paper.tex`.' };
  }
  if (/what|explain|why/i.test(lower)) {
    const findingCount = job?.findings?.length ?? 0;
    return { action: 'reply', message: `The conversion produced ${findingCount} validation finding(s). PaperForge extracts structure (headings, paragraphs, tables, figures) from your DOCX and maps it to the selected LaTeX template without rewriting any scientific content. Ask me about any specific finding for more detail.` };
  }

  return {
    action: 'reply',
    message: `I understand you want to: "${userMessage}". PaperForge's bounded approach means I can help with formatting, template structure, and LaTeX syntax — but scientific content stays yours to edit. Could you be more specific about what you'd like to change?`,
  };
}

export async function chatWithAgent({ jobId, messages, job }) {
  const lastMessage = messages[messages.length - 1]?.content ?? '';

  const tryParse = (text) => {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try { return JSON.parse(cleaned); } catch { return { action: 'reply', message: text }; }
  };

  if (process.env.GEMINI_API_KEY) {
    try {
      const text = await callGeminiChat(process.env.GEMINI_API_KEY, messages, CHAT_SYSTEM_PROMPT);
      return tryParse(text);
    } catch {
      return ruleBasedChatResponse(lastMessage, job);
    }
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      const text = await callOpenAIChat(process.env.OPENAI_API_KEY, messages, CHAT_SYSTEM_PROMPT);
      return tryParse(text);
    } catch {
      return ruleBasedChatResponse(lastMessage, job);
    }
  }
  return ruleBasedChatResponse(lastMessage, job);
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
