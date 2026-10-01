# Implementation Plan: Paper Conversion Workbench

## Technical Context

- **Runtime**: browser UI plus Node.js HTTP backend
- **Storage**: project-local `.codex-local/jobs/<job-id>` with source, PDF, report, and change log; no long-term database
- **Parsing**: Mammoth DOCX extraction with bounded file validation
- **Compilation**: project-local MiKTeX `pdflatex` with CTAN template cache
- **Reasoning**: server-side OpenAI Responses API adapter with explicit rule-based fallback when no key is configured
- **Testing**: browser smoke checks plus Node unit/integration checks
- **Constraints**: no external dependency installation; all project assets and setup state remain on E drive

## Direction

Build an operate-mode workbench with an editorial instrument visual language from `DESIGN.md`. The primary surface is a manuscript queue and active job detail view. A left rail anchors navigation, the center shows intent/progress/report state, and a compact right rail keeps trust and output affordances visible.

## Data Model

- `Job`: id, filename, size, target, status, stage, progress, createdAt, fileChecks, repairs, findings, outputs.
- `LedgerEntry`: stage, label, state, timestamp, rationale.
- `Finding`: id, severity, rule, message, confidence, location, requiresApproval.

## Interaction Model

1. Upload area validates and posts a real DOCX to the local backend.
2. Target control switches IEEEtran/acmart.
3. Backend extracts DOCX structure, generates LaTeX, compiles it, validates findings, and asks the configured reasoning provider for a bounded review.
4. Report controls filter findings and expand rationale.
5. Output buttons announce the requested deliverable and preserve the current job state.

## Risk Controls

- Uploads are capped at 25 MB and stored under the project-local job directory.
- No auto-edit of user content; LLM output is advisory JSON only.
- Missing template classes, compiler failures, and missing LLM credentials remain explicit findings.
- Accessibility and reduced-motion are built into the shell.
