# PaperForge --- Complete Specification Sheet (v1.0)

A bounded, agentic system for content-preserving academic paper
conversion and automated format validation.

------------------------------------------------------------------------

## 1) Purpose & Scope

-   **Purpose:** Convert a research paper (DOCX/LaTeX) into a target
    venue's LaTeX template (e.g., IEEEtran, ACM acmart) while preserving
    scientific content, validating compilation/assets/citations, and
    performing bounded self-correction with human approval for
    substantive changes.
-   **In scope (MVP):** DOCX → IEEEtran/ACM LaTeX; compile; validate
    citations/figures/tables; bounded repair loop; progress UI;
    validation report; editable source + PDF output.
-   **Out of scope (MVP):** Multi-format batch jobs; automatic
    bibliography creation from Word's hidden citation DB; semantic
    rewriting; journal submission automation; proprietary template
    redistribution.

------------------------------------------------------------------------

## 2) Users & Use Cases

-   **Primary users:** Students, researchers, and lab managers preparing
    manuscripts for conferences/journals.
-   **Key use cases:**
    -   Convert a DOCX manuscript to IEEE/ACM LaTeX without losing
        equations/tables/figures.
    -   Detect and fix compilation errors.
    -   Produce a validation report and change log.
    -   Require approval for content-affecting edits.

------------------------------------------------------------------------

## 3) Functional Requirements

## 3.1 Input & Pre-checks

-   Accepted inputs: DOCX (MVP); optional LaTeX (future).
-   Limits:
    -   File size ≤ 25 MB
    -   Pages ≤ 50
    -   Figures ≤ 50
    -   Tables ≤ 30
    -   References ≤ 300
-   Reject password-protected DOCX.
-   Require confirmation for scanned/image-heavy papers.

## 3.2 Structure Extraction

Extract:

-   Title
-   Authors
-   Affiliations
-   Abstract
-   Sections/subsections
-   Equations
-   Figures
-   Tables
-   Citations
-   References

Constraints:

-   OMML equations → LaTeX math.
-   Complex equations require review.
-   Simple tables are reconstructed; merged/nested tables require
    review.
-   Do not invent bibliography entries.
-   Accept user-provided `.bib`, CSL YAML, or placeholders.

## 3.3 Format Conversion

Templates:

-   Use official templates such as IEEEtran and ACM acmart.
-   Respect template licensing.

Rules:

-   Preserve original text verbatim.
-   Escape special characters only when required.
-   Never paraphrase scientific claims.
-   Substantive changes require approval.
-   Map figures/tables to template-compliant environments.

## 3.4 Automated Validation

Compile:

-   pdflatex/xelatex
-   Timeout: 120 seconds

Checks:

-   Compilation errors/warnings
-   Undefined references
-   Missing files
-   Font issues
-   Citation integrity
-   Duplicate bibliography keys
-   Missing bibliography entries
-   Asset presence
-   Template compliance

## 3.5 Self-Correction Loop

Policy:

-   Maximum retries: 3 per job.

Allowed fixes:

-   Escape special characters.
-   Correct file paths.
-   Fix bibliography keys.
-   Adjust table environments.
-   Add permitted packages.

Forbidden fixes:

-   Rewriting scientific content.
-   Changing scientific meaning.
-   Removing sections.
-   Changing authorship or affiliations.

Human approval required for substantive changes.

## 3.6 Output & Reporting

Deliverables:

-   Editable LaTeX source
-   Compiled PDF
-   Validation report
-   Change log

Report includes:

-   Fixes applied
-   Confidence scores
-   Remaining issues
-   Recommended manual actions

------------------------------------------------------------------------

## 4) Agentic UX & Transparency

## 4.1 Agent Card

Declare:

-   Capabilities: conversion, compilation, validation, bounded repair.
-   Data accessed: uploaded files and user-provided bibliography.
-   Allowed actions: source edits required for compilation.
-   Oversight: human approval for substantive changes.

## 4.2 Lifecycle UI

Stages:

1.  Intent Preview
2.  Action Proposal
3.  Execution Monitoring
4.  Outcome Verification
5.  Correction Affordance
6.  Escalation Pathway

Progress ledger:

-   Thinking
-   Converting
-   Compiling
-   Validating
-   Repairing
-   Ready

## 4.3 Trust Patterns

Features:

-   Explain rationale for every repair.
-   Show applied rule and confidence.
-   Maintain audit trail.
-   Allow rollback.
-   Flag low-confidence conversions.

------------------------------------------------------------------------

## 5) Technical Architecture (MVP)

## 5.1 Components

-   Parser: pandoc with filters.
-   Template manager: official template retrieval and license tracking.
-   Compiler service: sandboxed LaTeX compilation.
-   Validator: citation, asset, and template checks.
-   Repair agent: rule-based fixes + LLM diagnostics.
-   UI: progress tracking, reports, diffs, downloads.

## 5.2 Data & Storage

-   Default deletion after download (maximum 24 hours).
-   No training on user papers without explicit consent.
-   Encrypt uploads in transit and at rest.

------------------------------------------------------------------------

## 6) Constraints, Rules, Boundaries

## 6.1 Content Integrity

Rules:

-   Do not alter scientific claims, data, or conclusions.
-   Any substantive edit requires approval.

## 6.2 Legal & Licensing

-   Use official templates.
-   Respect licenses.
-   Do not fabricate references.
-   Follow publisher requirements.

## 6.3 Safety & Compliance

-   Treat academic documents as high-stakes content.
-   Require human review for risky actions.
-   Escalate repeated failures.

## 6.4 Performance

-   Compilation limit: 120 seconds.
-   Total job limit: 10 minutes.
-   Maximum repair iterations: 3.
-   Resource limits per job.

------------------------------------------------------------------------

## 7) Evaluation & Success Metrics

Metrics:

-   Compilation success rate.
-   Content preservation percentage.
-   Formatting compliance.
-   User trust and satisfaction.

------------------------------------------------------------------------

## 8) MVP Build Plan (1 Week)

### Day 1--2

-   DOCX parsing.
-   Template integration.
-   Baseline conversion.

### Day 3

-   Compilation service.
-   Log parsing.
-   Validation checks.

### Day 4

-   Repair loop.
-   Human approval gate.

### Day 5

-   UI.
-   Reports.
-   Diff viewer.

### Day 6

-   Testing.
-   Hardening.

### Day 7

-   Documentation.
-   Licensing.
-   Privacy.
-   Demo dataset.

------------------------------------------------------------------------

## 9) Risks & Mitigations

  Risk                        Mitigation
  --------------------------- -----------------------------------------
  Complex equations/tables    Manual review and preview
  Citation loss               Require user-provided bibliography
  Template licensing issues   Use official sources and track licenses
  Over-automation             Human approval and bounded repair
