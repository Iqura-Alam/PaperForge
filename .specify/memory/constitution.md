# PaperForge Constitution

## Core Principles

### I. Scientific Integrity Is Non-Negotiable

PaperForge MUST preserve scientific claims, data, equations, citations, authorship, affiliations,
and conclusions. Automated changes MUST be limited to formatting or mechanically verifiable
repairs. The system MUST NOT invent references, silently remove content, or paraphrase scientific
meaning. Every transformation MUST be attributable to an input region and recorded in an audit
trail. Scientific fidelity MUST be covered by executable fixtures and acceptance tests.

### II. The Product Runtime Is Web-Only

End users MUST complete upload, intent review, conversion, approval, monitoring, validation, and
download through a browser. Parsing, template retrieval, LaTeX compilation, validation, repair,
secret use, and persistent job state MUST run in managed cloud services. Users MUST NOT be asked
to install LaTeX, Node.js, Python, agents, or any PaperForge runtime locally. Local tools may be
used only for repository development and verification, subject to `AGENTS.md` storage rules.

### III. Agents Are Bounded and Human-Controlled

Every user-facing agent action MUST declare its goal, data scope, tools, proposed change,
rationale, confidence, and approval state. Safe mechanical repairs MAY run automatically within a
maximum of three attempts per job. Any action that could affect scientific meaning, authorship,
affiliation, evidence, or conclusions MUST pause for explicit human approval. Users MUST be able
to pause, cancel, reject, retry, inspect diffs, roll back applied repairs, and escalate to manual
recovery. Exhausted limits MUST stop automation rather than broaden authority.

### IV. Privacy, Security, and Tenant Isolation by Design

Uploads and generated artifacts MUST be encrypted in transit and at rest, authorized per user and
tenant, and inaccessible through public or guessable paths. Credentials MUST remain server-side in
a managed secret store and MUST NOT appear in browser bundles, logs, fixtures, or Git history.
Jobs MUST run in isolated, resource-bounded workers with network, process, file, memory, and time
limits. Artifacts MUST be deleted after an explicit user deletion or automatically within 24 hours,
with deletion auditable. Manuscript content MUST NOT be used for model training without separate,
explicit consent.

### V. Delivery Requires Executable Evidence

Production behavior MUST be developed test-first through a recorded RED, GREEN, and refactor cycle.
Unit, integration, contract, security, accessibility, and critical-browser-flow tests MUST cover the
applicable risk. Overall automated coverage MUST remain at or above 80%, with higher coverage for
authorization, retention, repair boundaries, and scientific-fidelity invariants. A task MUST NOT be
marked complete unless its acceptance criteria pass and the evidence is recorded. Build, lint, and
test commands MUST validate behavior rather than merely check file presence.

### VI. Agent Collaboration Has Explicit Contracts

Development work MUST use distinct orchestration, specification, implementation, testing, and
review responsibilities. The orchestrator owns scope, dependency order, and final integration; the
specification agent owns testable requirements and traceability; implementers own only assigned
files and tasks; testers independently verify acceptance, security, accessibility, and regression
behavior; reviewers reconcile evidence against the specification. Handoffs MUST include changed
artifacts, commands run, results, risks, and blockers. No agent may self-certify incomplete work or
expand permissions beyond the user's stated scope.

## Product and Security Constraints

- The production topology MUST separate the browser client, authenticated API, durable job state,
  private object storage, and isolated asynchronous conversion workers.
- Compilation MUST disable shell escape and outbound network access, enforce a 120-second compile
  limit, enforce a 10-minute total job limit, and cap CPU, memory, processes, and generated output.
- Upload validation MUST enforce DOCX type, 25 MB size, 50 pages, 50 figures, 30 tables, and 300
  references; password-protected files MUST be rejected and image-heavy files MUST require consent.
- Downloads MUST use short-lived, authorized delivery. Logs and telemetry MUST exclude manuscript
  content, credentials, and personally identifying document data.
- Official templates MUST come from traceable sources, and their versions and licenses MUST be
  recorded. Proprietary templates MUST NOT be redistributed without authorization.
- APIs MUST validate inputs, return safe errors, enforce rate and concurrency limits, support
  idempotency, and prevent cross-tenant access.
- Development dependencies, caches, generated setup state, and temporary files MUST remain inside
  this repository on the E drive as required by `AGENTS.md`.

## Development Workflow and Quality Gates

1. Specify: write testable user stories, functional requirements, measurable success criteria,
   privacy rules, agent boundaries, and failure behavior.
2. Plan: document cloud topology, contracts, data lifecycle, security controls, observability,
   licensing, migration, and rollback. Material architecture choices require an ADR proposal and
   user approval before the ADR is accepted.
3. Task: generate dependency-ordered tasks with user-story and requirement traceability, exact file
   ownership, independent test criteria, and explicit parallel boundaries.
4. Implement: use RED-GREEN-REFACTOR checkpoints; do not combine unrelated tasks or silently alter
   user-owned work.
5. Verify: run build, lint, coverage, integration, E2E, accessibility, security, dependency, and
   diff reviews. Re-run the Spec Kit analysis and convergence gates after implementation.
6. Ship: the tester and reviewer MUST independently approve the evidence before push or deployment.
   CI MUST reproduce the required gates. Deployment secrets and production changes require the
   explicitly authorized service accounts and environments.

Each pull request MUST identify the requirements satisfied, agent handoffs, RED/GREEN evidence,
security and privacy impact, migration or rollback needs, and remaining limitations. Failed gates
block merge; they cannot be converted to warnings without a documented constitutional amendment.

## Governance

This constitution supersedes conflicting plans, tasks, comments, and implementation shortcuts.
Every specification, plan, task list, review, and release MUST include a constitution compliance
check. Amendments require a written rationale, affected-artifact list, migration plan, semantic
version change, and explicit user approval. A MAJOR version changes or removes a core principle; a
MINOR version adds a principle or materially expands governance; a PATCH version clarifies existing
rules without changing their meaning. Temporary exceptions MUST name an owner, scope, expiry, risk,
and rollback plan; exceptions cannot waive scientific integrity, tenant isolation, secret safety,
or human approval for substantive edits.

**Version**: 1.0.0 | **Ratified**: 2026-10-01 | **Last Amended**: 2026-10-01
