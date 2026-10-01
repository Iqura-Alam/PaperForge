# Feature Specification: Paper Conversion Workbench

**Feature Branch**: `001-paper-conversion-workbench`
**Created**: 2026-10-01
**Status**: Ready for planning
**Input**: `PaperForge_Specification_Sheet_v1.0.md`

## User Scenarios & Testing

### User Story 1 - Start a trusted conversion (Priority: P1)

A researcher uploads a DOCX, chooses IEEEtran or acmart, and reviews an intent preview before any conversion begins.

**Acceptance Scenarios**:

1. Given no file is loaded, when the user opens PaperForge, then the interface explains accepted limits and offers a DOCX upload action.
2. Given a valid manuscript is selected, when the user selects a target template, then PaperForge shows file metadata, target, and the actions it may take.
3. Given a password-protected, oversized, or unsupported file, when the user submits it, then PaperForge explains the rejection and recovery step.

### User Story 2 - Monitor bounded execution (Priority: P1)

The researcher watches extraction, compilation, validation, and repair stages without guessing what the system is doing.

**Acceptance Scenarios**:

1. Given a confirmed intent preview, when the user starts conversion, then the progress ledger marks the current stage and shows a rationale.
2. Given a repair is proposed, when the repair could alter scientific content, then the UI pauses for human approval.
3. Given three repair attempts are exhausted, then the UI escalates remaining issues and does not continue automatically.

### User Story 3 - Inspect and export results (Priority: P1)

The researcher reviews validation findings, a change log, and editable outputs before downloading the package.

**Acceptance Scenarios**:

1. Given conversion completes, when the user opens the report, then the report lists compilation state, citation and asset checks, confidence, fixes, and remaining issues.
2. Given a finding is low confidence, when the user selects it, then the UI explains the rule and identifies the affected source region.
3. Given outputs are ready, when the user downloads the package, then source, PDF, validation report, and change log are available.

## Edge Cases

- Scanned or image-heavy documents require confirmation before extraction.
- Complex equations, merged tables, nested tables, missing bibliography entries, and missing assets remain flagged for review.
- A failed compile shows the error, the bounded repair count, and a manual recovery path.
- Empty, loading, success, and error states remain usable with keyboard navigation.

## Requirements

- **FR-001**: The product MUST accept DOCX manuscripts and show size, page, figure, table, and reference limits before conversion.
- **FR-002**: The product MUST let users select IEEEtran or acmart as the output target.
- **FR-003**: The product MUST preserve title, authors, affiliations, abstract, sections, equations, figures, tables, citations, and references in the conversion model.
- **FR-004**: The product MUST display an intent preview that names data accessed, allowed actions, and the human approval boundary.
- **FR-005**: The product MUST show lifecycle stages for thinking, converting, compiling, validating, repairing, and ready.
- **FR-006**: The product MUST cap automatic repair attempts at three per job.
- **FR-007**: The product MUST distinguish safe formatting repairs from substantive edits requiring approval.
- **FR-008**: The product MUST provide a validation report and change log with confidence and remaining issues.
- **FR-009**: The product MUST provide editable LaTeX source, compiled PDF, validation report, and change log as output actions.
- **FR-010**: The product MUST make rollback and escalation available after a repair or failed compile.
- **FR-011**: The product MUST avoid inventing bibliography entries or altering scientific meaning.
- **FR-012**: The product MUST communicate privacy and retention defaults before upload.

## Success Criteria

- **SC-001**: A user can move from file selection to an approved conversion plan in under two minutes.
- **SC-002**: Users can identify current stage, next action, and approval boundary within five seconds of viewing the workbench.
- **SC-003**: 100% of displayed repair proposals include a rationale, rule, confidence, and approval state.
- **SC-004**: A completed job exposes all four required deliverables without requiring the user to reconstruct filenames.
- **SC-005**: The interface remains usable at 320px wide and with keyboard-only navigation.

## Assumptions

- The first shipped experience is a front-end MVP with deterministic demo data; service integration can replace the simulated job runner later.
- Official template files are referenced by name and license state rather than redistributed in this repository.
- Users provide bibliography data when source material does not contain complete references.

## Out of Scope

Batch conversion, bibliography creation from Word's hidden citation database, semantic rewriting, submission automation, and proprietary template redistribution.
