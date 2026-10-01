# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: static HTML, CSS, and JavaScript for a dependency-free MVP that can be run locally without installing outside the E drive.

## Users

Students, researchers, and lab managers preparing academic manuscripts for a conference or journal.

## Product Purpose

PaperForge converts a DOCX manuscript into an editable venue-ready LaTeX workspace while preserving scientific content, showing bounded validation, and keeping people in control of substantive changes.

## Positioning

PaperForge treats conversion as an auditable production workflow: every repair has a rationale, confidence, and approval boundary instead of silently rewriting a paper.

## Operating Context

Users upload a manuscript, select an IEEE or ACM target, review an intent preview, monitor extraction and compilation, inspect validation findings, and download source, PDF, and reports.

## Capabilities and Constraints

The MVP accepts DOCX manuscripts up to 25 MB and 50 pages, supports IEEEtran and acmart targets, exposes progress stages, validates citations/assets/templates, and permits at most three bounded repair attempts. Substantive edits require human approval. Uploaded content is temporary and is not used for training without consent.

## Brand Commitments

The name PaperForge suggests careful, visible craft. Voice is precise, calm, and plainspoken. The interface must make trust boundaries visible.

## Evidence on Hand

The product requirements are defined in `PaperForge_Specification_Sheet_v1.0.md`. No user manuscripts, logos, or production template files are supplied; the UI must not fabricate them.

## Product Principles

- Preserve first: never trade scientific meaning for formatting convenience.
- Show the work: make each stage, rule, confidence, and remaining issue visible.
- Bound automation: repair only within explicit limits and escalate risky changes.
- Keep outputs editable: source and reports are first-class deliverables.

## Accessibility & Inclusion

Use semantic HTML, keyboard-visible focus, at least 44px touch targets, readable contrast, reduced-motion support, and status text that does not rely on color alone.
